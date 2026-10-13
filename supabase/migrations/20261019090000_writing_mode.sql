-- Schema version 10: the Writing Challenge.
--
-- Writing is a practice mode like the others: the learner writes a sentence
-- with the word, the answer is judged by the same kind of automatic check,
-- and nothing here moves a word's mastery, review date or FSRS state. Two
-- things are new. A written answer is a short essay, so the submitted text
-- may be longer than any typed word; and where a language model is
-- configured, its coaching note and one model sentence are kept beside the
-- answer they comment on — in the same row, so the history never has to be
-- joined to know what was said. A database without a model simply has nulls
-- there, and the mode works exactly as before.
--
-- Additive only; run this file once, after the version 9 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 10 $$;

-- ---------------------------------------------------------------------------
-- Review history: essays allowed, one more mode, the coach's two texts
-- ---------------------------------------------------------------------------

-- A written answer may now be an essay. Dropping the check and adding it back
-- with the longer limit touches no stored value: every shorter answer still
-- satisfies it. Replacing a function that returns the same table needs no
-- drop, and the new columns ride the table's own select and insert policies,
-- so no grant changes anywhere in this file.
alter table public.review_logs
  drop constraint review_logs_submitted_answer_check;

alter table public.review_logs
  add constraint review_logs_submitted_answer_check
    check (submitted_answer is null or char_length(submitted_answer) <= 6000);

-- The same list as version 6, with writing appended.
alter table public.review_logs
  drop constraint review_logs_mode_check;

alter table public.review_logs
  add constraint review_logs_mode_check
    check (review_mode in ('flashcard', 'recognition', 'recall', 'typing', 'cloze', 'listening', 'writing'));

alter table public.review_logs
  -- What the writing coach said about the answer, when a model was asked and answered.
  add column ai_feedback text check (ai_feedback is null or char_length(ai_feedback) <= 2000),
  -- One better example sentence from the same model, to compare against the learner's own.
  add column model_answer text check (model_answer is null or char_length(model_answer) <= 300);

-- ---------------------------------------------------------------------------
-- Recording a written answer with its coach note
-- ---------------------------------------------------------------------------

-- The same event as version 6, with two optional keys the writing mode adds:
--
--   { ..., "ai_feedback"?, "model_answer"? }
--
-- They are read only when present; every other practice event passes without
-- them, exactly as before. The verdict (`answer_correct`) is decided before
-- this function runs and never depends on the coach. Returns 'recorded',
-- 'already_recorded' or 'not_found' as before, and reads the word's schedule
-- only to copy it into the row; it never writes it.
create or replace function public.record_practice(p_event jsonb)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_vocabulary uuid := (p_event ->> 'vocabulary_id')::uuid;
  v_request uuid := (p_event ->> 'request_id')::uuid;
  v_session uuid := (p_event ->> 'session_id')::uuid;
  v_mode text := p_event ->> 'review_mode';
  v_correct boolean := (p_event ->> 'answer_correct')::boolean;
  v_grading text := p_event ->> 'grading';
  v_submitted text := p_event ->> 'submitted_answer';
  v_reviewed_on date := (p_event ->> 'reviewed_on')::date;
  v_duration integer := (p_event ->> 'duration_ms')::integer;
  v_confidence smallint := (p_event ->> 'confidence')::smallint;
  v_feedback text := p_event ->> 'ai_feedback';
  v_model text := p_event ->> 'model_answer';
  v_log public.review_logs;
  v_state public.card_states;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_vocabulary is null or v_request is null or v_mode is null or v_correct is null
     or v_grading is null or v_reviewed_on is null then
    raise exception 'incomplete practice event' using errcode = '22023';
  end if;
  if v_mode = 'flashcard' then
    raise exception 'a flashcard answer is a review, not practice' using errcode = '22023';
  end if;
  if v_confidence is not null and v_confidence not between 1 and 3 then
    raise exception 'confidence must be 1, 2 or 3' using errcode = '22023';
  end if;

  select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = v_request;
  if found then
    if v_log.kind <> 'practice' then
      raise exception 'request id was used for another kind of event' using errcode = '22023';
    end if;
    return query select 'already_recorded'::text;
    return;
  end if;

  select c.* into v_state from public.card_states c
    join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
   where c.vocabulary_id = v_vocabulary and c.user_id = v_user and v.deleted_at is null;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  if v_session is not null then
    insert into public.study_sessions (id, user_id, mode) values (v_session, v_user, v_mode)
      on conflict (id) do nothing;
    if not exists (select 1 from public.study_sessions s where s.id = v_session and s.user_id = v_user) then
      raise exception 'session belongs to another user' using errcode = '42501';
    end if;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, kind, session_id, action, review_mode, reviewed_on, duration_ms,
     mastery_before, mastery_after, review_date_before, review_date_after,
     confidence, answer_correct, submitted_answer, grading, ai_feedback, model_answer)
  values
    (v_user, v_vocabulary, v_request, 'practice', v_session,
     case when v_correct then 'remember' else 'not_remember' end, v_mode, v_reviewed_on, v_duration,
     v_state.mastery, v_state.mastery, v_state.review_date, v_state.review_date,
     v_confidence, v_correct, v_submitted, v_grading, v_feedback, v_model);

  return query select 'recorded'::text;
end;
$$;
