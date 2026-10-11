-- Schema version 6: practice in other study modes.
--
-- Recognition, recall, typing and cloze are practice. An answer given in one
-- of them is recorded in the same history, in the same shape, as a flashcard
-- review, but as a row of kind 'practice' that never changes a word's mastery,
-- its review date or its FSRS state. Only a flashcard review moves the
-- schedule, exactly as before.
--
-- Additive only; run this file once, after the version 5 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 6 $$;

-- ---------------------------------------------------------------------------
-- Review history: one more kind of event, and what was answered
-- ---------------------------------------------------------------------------

alter table public.review_logs
  drop constraint review_logs_kind_check,
  add constraint review_logs_kind_check check (kind in ('review', 'undo', 'practice'));

alter table public.review_logs
  -- Whether a practice answer was right. Left empty for a flashcard review,
  -- where `action` already says whether the reviewer chose Remember.
  add column answer_correct boolean,
  -- What was typed, in the modes where something is typed.
  add column submitted_answer text check (submitted_answer is null or char_length(submitted_answer) <= 500),
  -- Who decided it was right: the reviewer ('self') or a comparison ('auto').
  add column grading text check (grading is null or grading in ('self', 'auto'));

alter table public.review_logs
  add constraint review_logs_mode_check
    check (review_mode in ('flashcard', 'recognition', 'recall', 'typing', 'cloze', 'listening')),
  -- A practice answer records an outcome and leaves the schedule exactly as it found it.
  add constraint review_logs_practice_shape check (
    kind <> 'practice'
    or (answer_correct is not null
        and grading is not null
        and review_mode <> 'flashcard'
        and mastery_before = mastery_after
        and review_date_before is not distinct from review_date_after
        and fsrs_before is null
        and fsrs_after is null)
  );

create index review_logs_practice_idx on public.review_logs (user_id, reviewed_on) where kind = 'practice';

-- The same rows as before, with the new columns appended. Practice is not in
-- this view: everything computed from it (activity, streaks, the daily goal,
-- weak words) goes on counting scheduled reviews only.
create or replace view public.effective_reviews with (security_invoker = true) as
select r.*
  from public.review_logs r
 where r.kind = 'review'
   and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id);

-- ---------------------------------------------------------------------------
-- Recording a practice answer
-- ---------------------------------------------------------------------------

-- The event:
--
--   { "vocabulary_id", "request_id", "review_mode", "answer_correct",
--     "grading": "self" | "auto", "reviewed_on",
--     "session_id"?, "submitted_answer"?, "duration_ms"?, "confidence"? }
--
-- Returns 'recorded', 'already_recorded' (the same request id was recorded
-- before; nothing is added) or 'not_found' (no such live word of the caller's).
-- It reads the word's schedule only to copy it into the row; it never writes it.
create function public.record_practice(p_event jsonb)
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
     confidence, answer_correct, submitted_answer, grading)
  values
    (v_user, v_vocabulary, v_request, 'practice', v_session,
     case when v_correct then 'remember' else 'not_remember' end, v_mode, v_reviewed_on, v_duration,
     v_state.mastery, v_state.mastery, v_state.review_date, v_state.review_date,
     v_confidence, v_correct, v_submitted, v_grading);

  return query select 'recorded'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Practice results by day and mode
-- ---------------------------------------------------------------------------

-- One row per calendar day and study mode on which the caller practised.
-- Modes measure different skills, so they are never added together here.
create function public.practice_daily_stats(p_from date, p_to date)
returns table (
  day date,
  review_mode text,
  answers integer,
  correct integer,
  duration_ms bigint,
  timed_answers integer,
  cards integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.reviewed_on,
    l.review_mode,
    count(*)::integer,
    count(*) filter (where l.answer_correct)::integer,
    coalesce(sum(l.duration_ms), 0)::bigint,
    count(l.duration_ms)::integer,
    count(distinct l.vocabulary_id)::integer
  from public.review_logs l
  where l.user_id = (select auth.uid())
    and l.kind = 'practice'
    and l.reviewed_on between p_from and p_to
  group by l.reviewed_on, l.review_mode
  order by l.reviewed_on, l.review_mode;
$$;

revoke all on function public.record_practice(jsonb) from anon, authenticated, public;
revoke all on function public.practice_daily_stats(date, date) from anon, authenticated, public;
grant execute on function public.record_practice(jsonb) to authenticated;
grant execute on function public.practice_daily_stats(date, date) to authenticated;
