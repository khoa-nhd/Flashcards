-- Schema version 3: FSRS calculated in the background.
--
-- From here on, every saved answer can also carry the FSRS state it leads to.
-- That state is stored beside the mastery schedule and does NOT decide what is
-- due: the review queue is unchanged. Additive only; run this file once, after
-- the version 2 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 3 $$;

-- ---------------------------------------------------------------------------
-- Card state: the FSRS fields the first migration did not have
-- ---------------------------------------------------------------------------

alter table public.card_states
  add column fsrs_scheduled_days integer check (fsrs_scheduled_days is null or fsrs_scheduled_days >= 0),
  add column fsrs_learning_steps integer check (fsrs_learning_steps is null or fsrs_learning_steps >= 0);

-- A card either has a complete FSRS state or none at all. A card that FSRS has
-- never seen keeps every field empty: nothing is filled in on its behalf.
alter table public.card_states
  add constraint card_states_fsrs_all_or_nothing check (
    (fsrs_due is null and fsrs_stability is null and fsrs_difficulty is null and fsrs_state is null
       and fsrs_reps is null and fsrs_lapses is null and fsrs_scheduled_days is null
       and fsrs_learning_steps is null and fsrs_last_review is null and fsrs_version is null)
    or
    (fsrs_due is not null and fsrs_stability > 0 and fsrs_difficulty between 1 and 10
       and fsrs_state between 0 and 3 and fsrs_reps is not null and fsrs_lapses is not null
       and fsrs_scheduled_days is not null and fsrs_learning_steps is not null and fsrs_version is not null)
  );

create index card_states_fsrs_due_idx on public.card_states (user_id, fsrs_due) where fsrs_due is not null;

-- ---------------------------------------------------------------------------
-- Review history: what FSRS made of each answer
-- ---------------------------------------------------------------------------

alter table public.review_logs
  -- The FSRS rating the answer was given as: 1 Again, 2 Hard, 3 Good, 4 Easy.
  add column rating smallint check (rating is null or rating between 1 and 4),
  -- The FSRS state before and after, as stored. Null where FSRS was not calculated.
  add column fsrs_before jsonb,
  add column fsrs_after jsonb,
  add column fsrs_version text;

-- ---------------------------------------------------------------------------
-- Settings: the retention FSRS aims for
-- ---------------------------------------------------------------------------

alter table public.user_settings
  add column fsrs_request_retention numeric(4, 3) not null default 0.900
    check (fsrs_request_retention between 0.700 and 0.970);

-- ---------------------------------------------------------------------------
-- Views: the same rows, with the new columns appended
-- ---------------------------------------------------------------------------

create or replace view public.vocabulary_cards with (security_invoker = true) as
select
  v.id,
  v.user_id,
  v.word,
  v.word_key,
  v.meaning,
  v.definition,
  v.example,
  v.date_added,
  v.created_at,
  greatest(v.updated_at, c.updated_at) as updated_at,
  v.deleted_at,
  c.mastery,
  c.review_date,
  c.fsrs_due,
  c.fsrs_stability,
  c.fsrs_difficulty,
  c.fsrs_last_review,
  c.fsrs_reps,
  c.fsrs_lapses,
  c.fsrs_state,
  c.fsrs_scheduled_days,
  c.fsrs_learning_steps,
  c.fsrs_version
from public.vocabulary v
join public.card_states c on c.vocabulary_id = v.id and c.user_id = v.user_id;

create or replace view public.effective_reviews with (security_invoker = true) as
select r.*
  from public.review_logs r
 where r.kind = 'review'
   and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id);

-- ---------------------------------------------------------------------------
-- Saving an answer, now with its FSRS state
-- ---------------------------------------------------------------------------

-- Same contract as before. The event may also carry:
--
--   "fsrs": { "rating": 3, "version": "…", "before": {…} | null, "after": {…} }
--
-- where each state is { due, stability, difficulty, last_review, reps, lapses,
-- state, scheduled_days, learning_steps, version }.
--
-- When it does, the card's FSRS fields are written in the same statement as
-- its mastery and review date, so the two schedules can never disagree about
-- which answers they have seen. Without it, the FSRS fields are left alone.
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
     rating, fsrs_before, fsrs_after, fsrs_version)
  values
    (v_user, v_vocabulary, v_request, 'review', v_session, v_action, v_mode, v_reviewed_on, v_duration,
     v_expected_mastery, v_new_mastery, v_expected_date, v_new_date,
     (v_fsrs ->> 'rating')::smallint, v_before, v_after, v_fsrs ->> 'version');

  return query select 'applied'::text, v_state.mastery, v_state.review_date;
end;
$$;

-- ---------------------------------------------------------------------------
-- Undoing an answer, including what FSRS made of it
-- ---------------------------------------------------------------------------

-- Same contract as before. An answer that was saved with an FSRS state has
-- that state put back as well (to empty, if the card had none before it). An
-- older answer, saved before FSRS was calculated, leaves the FSRS fields alone.
create or replace function public.undo_review(p_review_request_id uuid, p_request_id uuid)
returns table (outcome text, vocabulary_id uuid, mastery smallint, review_date date)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_target public.review_logs;
  v_undo public.review_logs;
  v_state public.card_states;
  v_had_fsrs boolean;
  v_prior jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_review_request_id is null or p_request_id is null then
    raise exception 'incomplete undo request' using errcode = '22023';
  end if;

  select * into v_target from public.review_logs l
   where l.user_id = v_user and l.request_id = p_review_request_id and l.kind = 'review';
  if not found then
    return query select 'not_found'::text, null::uuid, null::smallint, null::date;
    return;
  end if;

  select * into v_undo from public.review_logs l where l.user_id = v_user and l.request_id = p_request_id;
  if found and (v_undo.kind <> 'undo' or v_undo.undoes_log_id <> v_target.id) then
    raise exception 'request id was used for another event' using errcode = '22023';
  end if;
  if not found then
    select * into v_undo from public.review_logs l where l.undoes_log_id = v_target.id;
  end if;
  if found then
    return query select 'already_undone'::text, v_target.vocabulary_id, v_undo.mastery_after, v_undo.review_date_after;
    return;
  end if;

  if exists (
    select 1 from public.review_logs r
     where r.user_id = v_user
       and r.vocabulary_id = v_target.vocabulary_id
       and r.kind = 'review'
       and (r.reviewed_at, r.id) > (v_target.reviewed_at, v_target.id)
       and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id)
  ) then
    select c.* into v_state from public.card_states c
     where c.vocabulary_id = v_target.vocabulary_id and c.user_id = v_user;
    return query select 'not_latest'::text, v_target.vocabulary_id, v_state.mastery, v_state.review_date;
    return;
  end if;

  v_had_fsrs := v_target.fsrs_after is not null;
  v_prior := case when jsonb_typeof(v_target.fsrs_before) = 'object' then v_target.fsrs_before end;

  update public.card_states c
     set mastery = v_target.mastery_before,
         review_date = v_target.review_date_before,
         fsrs_due = case when v_had_fsrs then (v_prior ->> 'due')::timestamptz else c.fsrs_due end,
         fsrs_stability = case when v_had_fsrs then (v_prior ->> 'stability')::double precision else c.fsrs_stability end,
         fsrs_difficulty = case when v_had_fsrs then (v_prior ->> 'difficulty')::double precision else c.fsrs_difficulty end,
         fsrs_last_review = case when v_had_fsrs then (v_prior ->> 'last_review')::timestamptz else c.fsrs_last_review end,
         fsrs_reps = case when v_had_fsrs then (v_prior ->> 'reps')::integer else c.fsrs_reps end,
         fsrs_lapses = case when v_had_fsrs then (v_prior ->> 'lapses')::integer else c.fsrs_lapses end,
         fsrs_state = case when v_had_fsrs then (v_prior ->> 'state')::smallint else c.fsrs_state end,
         fsrs_scheduled_days = case when v_had_fsrs then (v_prior ->> 'scheduled_days')::integer else c.fsrs_scheduled_days end,
         fsrs_learning_steps = case when v_had_fsrs then (v_prior ->> 'learning_steps')::integer else c.fsrs_learning_steps end,
         -- Each stored state names the engine that produced it, so the earlier one is restored exactly.
         fsrs_version = case when not v_had_fsrs then c.fsrs_version
                             when v_prior is null then null
                             else coalesce(v_prior ->> 'version', v_target.fsrs_version) end
   where c.vocabulary_id = v_target.vocabulary_id
     and c.user_id = v_user
     and c.mastery = v_target.mastery_after
     and c.review_date is not distinct from v_target.review_date_after
     and exists (select 1 from public.vocabulary v
                  where v.id = v_target.vocabulary_id and v.user_id = v_user and v.deleted_at is null)
  returning * into v_state;

  if not found then
    select * into v_undo from public.review_logs l where l.undoes_log_id = v_target.id;
    if found then
      return query select 'already_undone'::text, v_target.vocabulary_id, v_undo.mastery_after, v_undo.review_date_after;
      return;
    end if;
    select c.* into v_state from public.card_states c
     where c.vocabulary_id = v_target.vocabulary_id and c.user_id = v_user;
    return query select 'conflict'::text, v_target.vocabulary_id, v_state.mastery, v_state.review_date;
    return;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, kind, undoes_log_id, session_id, action, review_mode, reviewed_on,
     mastery_before, mastery_after, review_date_before, review_date_after, scheduler,
     rating, fsrs_before, fsrs_after, fsrs_version)
  values
    (v_user, v_target.vocabulary_id, p_request_id, 'undo', v_target.id, v_target.session_id, v_target.action,
     v_target.review_mode, v_target.reviewed_on,
     v_target.mastery_after, v_target.mastery_before, v_target.review_date_after, v_target.review_date_before,
     v_target.scheduler,
     v_target.rating, v_target.fsrs_after, v_prior, v_target.fsrs_version);

  return query select 'undone'::text, v_target.vocabulary_id, v_state.mastery, v_state.review_date;
end;
$$;
