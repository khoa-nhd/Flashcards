-- Schema version 5: daily goals and confidence ratings.
--
-- A daily goal is a target the account sets for itself. It is only ever
-- compared with what was reviewed; it never changes which words are due, and
-- it never touches a scheduling parameter.
--
-- A confidence rating is what the reviewer said before seeing the answer. It
-- is stored beside the answer and is never used in place of it.
--
-- Additive only; run this file once, after the version 4 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 5 $$;

-- ---------------------------------------------------------------------------
-- Settings: the daily goal. Empty means no goal of that kind.
-- ---------------------------------------------------------------------------

alter table public.user_settings
  add column daily_goal_reviews smallint check (daily_goal_reviews is null or daily_goal_reviews between 1 and 1000),
  add column daily_goal_minutes smallint check (daily_goal_minutes is null or daily_goal_minutes between 1 and 600);

-- ---------------------------------------------------------------------------
-- Review history: how sure the reviewer was before the answer was shown
-- ---------------------------------------------------------------------------

alter table public.review_logs
  -- 1 low, 2 medium, 3 high. Empty when the reviewer was not asked or did not say.
  add column confidence smallint check (confidence is null or confidence between 1 and 3);

-- The same rows as before, with the new column appended.
create or replace view public.effective_reviews with (security_invoker = true) as
select r.*
  from public.review_logs r
 where r.kind = 'review'
   and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id);

-- ---------------------------------------------------------------------------
-- Saving an answer, now with its confidence rating
-- ---------------------------------------------------------------------------

-- Same contract as version 3. The event may also carry "confidence": 1 | 2 | 3.
create or replace function public.record_review(p_event jsonb)
returns table (outcome text, mastery smallint, review_date date)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_vocabulary uuid := (p_event ->> 'vocabulary_id')::uuid;
  v_request uuid := (p_event ->> 'request_id')::uuid;
  v_session uuid := (p_event ->> 'session_id')::uuid;
  v_action text := p_event ->> 'action';
  v_mode text := coalesce(p_event ->> 'review_mode', 'flashcard');
  v_expected_mastery smallint := (p_event ->> 'expected_mastery')::smallint;
  v_expected_date date := (p_event ->> 'expected_review_date')::date;
  v_new_mastery smallint := (p_event ->> 'new_mastery')::smallint;
  v_new_date date := (p_event ->> 'new_review_date')::date;
  v_reviewed_on date := (p_event ->> 'reviewed_on')::date;
  v_duration integer := (p_event ->> 'duration_ms')::integer;
  v_confidence smallint := (p_event ->> 'confidence')::smallint;
  v_fsrs jsonb := case when jsonb_typeof(p_event -> 'fsrs') = 'object' then p_event -> 'fsrs' end;
  v_after jsonb := case when jsonb_typeof(v_fsrs -> 'after') = 'object' then v_fsrs -> 'after' end;
  v_before jsonb := case when jsonb_typeof(v_fsrs -> 'before') = 'object' then v_fsrs -> 'before' end;
  v_log public.review_logs;
  v_state public.card_states;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_vocabulary is null or v_request is null or v_action is null
     or v_expected_mastery is null or v_new_mastery is null or v_reviewed_on is null then
    raise exception 'incomplete review event' using errcode = '22023';
  end if;
  if v_fsrs is not null and (v_after is null or (v_fsrs ->> 'rating') is null or (v_fsrs ->> 'version') is null) then
    raise exception 'incomplete FSRS state in review event' using errcode = '22023';
  end if;
  if v_confidence is not null and v_confidence not between 1 and 3 then
    raise exception 'confidence must be 1, 2 or 3' using errcode = '22023';
  end if;

  select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = v_request;
  if found then
    if v_log.kind <> 'review' then
      raise exception 'request id was used for another kind of event' using errcode = '22023';
    end if;
    if exists (select 1 from public.review_logs u where u.undoes_log_id = v_log.id) then
      select c.* into v_state from public.card_states c
       where c.vocabulary_id = v_log.vocabulary_id and c.user_id = v_user;
      return query select 'undone'::text, v_state.mastery, v_state.review_date;
      return;
    end if;
    return query select 'already_applied'::text, v_log.mastery_after, v_log.review_date_after;
    return;
  end if;

  if v_session is not null then
    insert into public.study_sessions (id, user_id, mode) values (v_session, v_user, v_mode)
      on conflict (id) do nothing;
    if not exists (select 1 from public.study_sessions s where s.id = v_session and s.user_id = v_user) then
      raise exception 'session belongs to another user' using errcode = '42501';
    end if;
  end if;

  -- One statement moves both schedules. The compare-and-set on the mastery
  -- state guards the FSRS state too: both were read together, and any answer
  -- that changed one has changed the other.
  update public.card_states c
     set mastery = v_new_mastery,
         review_date = v_new_date,
         fsrs_due = case when v_after is null then c.fsrs_due else (v_after ->> 'due')::timestamptz end,
         fsrs_stability = case when v_after is null then c.fsrs_stability else (v_after ->> 'stability')::double precision end,
         fsrs_difficulty = case when v_after is null then c.fsrs_difficulty else (v_after ->> 'difficulty')::double precision end,
         fsrs_last_review = case when v_after is null then c.fsrs_last_review else (v_after ->> 'last_review')::timestamptz end,
         fsrs_reps = case when v_after is null then c.fsrs_reps else (v_after ->> 'reps')::integer end,
         fsrs_lapses = case when v_after is null then c.fsrs_lapses else (v_after ->> 'lapses')::integer end,
         fsrs_state = case when v_after is null then c.fsrs_state else (v_after ->> 'state')::smallint end,
         fsrs_scheduled_days = case when v_after is null then c.fsrs_scheduled_days else (v_after ->> 'scheduled_days')::integer end,
         fsrs_learning_steps = case when v_after is null then c.fsrs_learning_steps else (v_after ->> 'learning_steps')::integer end,
         fsrs_version = case when v_after is null then c.fsrs_version
                             else coalesce(v_after ->> 'version', v_fsrs ->> 'version') end
   where c.vocabulary_id = v_vocabulary
     and c.user_id = v_user
     and c.mastery = v_expected_mastery
     and c.review_date is not distinct from v_expected_date
     and exists (select 1 from public.vocabulary v
                  where v.id = v_vocabulary and v.user_id = v_user and v.deleted_at is null)
  returning * into v_state;

  if not found then
    select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = v_request;
    if found then
      return query select 'already_applied'::text, v_log.mastery_after, v_log.review_date_after;
      return;
    end if;

    select c.* into v_state from public.card_states c
      join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
     where c.vocabulary_id = v_vocabulary and c.user_id = v_user and v.deleted_at is null;
    if not found then
      return query select 'not_found'::text, null::smallint, null::date;
      return;
    end if;
    return query select 'conflict'::text, v_state.mastery, v_state.review_date;
    return;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, kind, session_id, action, review_mode, reviewed_on, duration_ms,
     mastery_before, mastery_after, review_date_before, review_date_after,
     rating, fsrs_before, fsrs_after, fsrs_version, confidence)
  values
    (v_user, v_vocabulary, v_request, 'review', v_session, v_action, v_mode, v_reviewed_on, v_duration,
     v_expected_mastery, v_new_mastery, v_expected_date, v_new_date,
     (v_fsrs ->> 'rating')::smallint, v_before, v_after, v_fsrs ->> 'version', v_confidence);

  return query select 'applied'::text, v_state.mastery, v_state.review_date;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calibration: how answers went at each level of confidence
-- ---------------------------------------------------------------------------

-- One row per confidence level the caller has used since `p_since`, counting
-- only answers that still stand. Answers given without a rating are left out.
create function public.confidence_stats(p_since date)
returns table (confidence smallint, reviews integer, remembered integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.confidence,
    count(*)::integer,
    count(*) filter (where e.action = 'remember')::integer
  from public.effective_reviews e
  where e.user_id = (select auth.uid())
    and e.confidence is not null
    and e.reviewed_on >= p_since
  group by e.confidence
  order by e.confidence;
$$;

revoke all on function public.confidence_stats(date) from anon, authenticated, public;
grant execute on function public.confidence_stats(date) to authenticated;
