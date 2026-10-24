-- Schema version 15: FSRS becomes the only schedule (first, additive step).
--
-- The owner's decisions (2026-10-21, docs/fsrs-only-redesign.md): FSRS alone
-- decides when a word is due; mastery and its review date are no longer
-- written, and leave in a later clean-up (version 16). A display-only "memory
-- strength" is read from FSRS stability by the app.
--
-- What this file does:
--   - adds a fallback due day (`due_on`) for a word FSRS has not seen yet, a
--     `revision` that guards every answer against a stale write, and a manual
--     archive (`suspended_at`);
--   - adds the settings the new screens keep (two daily goals, maintenance
--     mode, an optional daily review limit, the interface language);
--   - adds functions that save and take back an answer under FSRS alone. The
--     version 8 `record_review` and `undo_review` stay, so the app deployed
--     before this file keeps working until the new one replaces it;
--   - gives every word that has been studied but has no FSRS state yet a
--     one-off estimated state from its mastery (owner's decision: estimate,
--     keep the old due day, a past due day is due at once). Words never
--     studied are left new. Existing FSRS states are never touched.
--
-- Mastery and review_date are kept, frozen at their last values, so going
-- back to the previous app still reads them correctly.
--
-- Additive only. Run once, after version 14. Every statement can be run again
-- if the SQL Editor stops partway.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 15 $$;

-- ---------------------------------------------------------------------------
-- Card state: fallback due day, revision, archive
-- ---------------------------------------------------------------------------

alter table public.card_states
  add column if not exists due_on date,
  add column if not exists revision bigint not null default 0,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

alter table public.card_states drop constraint if exists card_states_revision_check;
alter table public.card_states add constraint card_states_revision_check check (revision >= 0);

alter table public.card_states drop constraint if exists card_states_suspended_check;
alter table public.card_states add constraint card_states_suspended_check check (
  (suspended_at is null and suspended_reason is null)
  or (suspended_at is not null and suspended_reason = 'archived')
);

create index if not exists card_states_due_on_idx on public.card_states (user_id, due_on) where fsrs_due is null;

-- A new word starts with its fallback due day set to the review day it was
-- created with. The app sends the day it should first come up (today, or a
-- later day when an import is spread out). With no day at all, the app reads
-- the word as due at once.
create or replace function public.card_states_default_due_on() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.fsrs_due is null and new.due_on is null then
    new.due_on := new.review_date;
  end if;
  return new;
end;
$$;

drop trigger if exists card_states_default_due_on on public.card_states;
create trigger card_states_default_due_on before insert on public.card_states
  for each row execute function public.card_states_default_due_on();

-- ---------------------------------------------------------------------------
-- Review history: what an answer did under FSRS alone
-- ---------------------------------------------------------------------------

alter table public.review_logs
  add column if not exists revision_before bigint,
  add column if not exists revision_after bigint,
  add column if not exists due_on_before date,
  add column if not exists due_on_after date,
  -- False when the reviewer chose not to let this answer move the word.
  add column if not exists counted_toward_schedule boolean,
  -- True for the first answer a word ever gets: the day it is brought into study.
  add column if not exists counted_as_new boolean;

-- ---------------------------------------------------------------------------
-- Settings for the new screens
-- ---------------------------------------------------------------------------

alter table public.user_settings
  -- Null until the reviewer has chosen; the app then suggests 10, 30 and 20.
  add column if not exists study_goal_new_words integer check (study_goal_new_words between 0 and 1000),
  add column if not exists study_goal_reviews integer check (study_goal_reviews between 0 and 1000),
  add column if not exists study_goal_practice integer check (study_goal_practice between 0 and 1000),
  -- Lets the new-word goal be 0 for someone who has nothing left to add.
  add column if not exists maintenance_mode boolean not null default false,
  -- Null shows everything that is due.
  add column if not exists max_reviews_per_day integer check (max_reviews_per_day between 1 and 1000),
  -- Null follows the browser.
  add column if not exists ui_language text check (ui_language in ('vi', 'en'));

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
  c.fsrs_version,
  c.due_on,
  c.revision,
  c.suspended_at,
  c.suspended_reason
from public.vocabulary v
join public.card_states c on c.vocabulary_id = v.id and c.user_id = v.user_id;

-- ---------------------------------------------------------------------------
-- One card's FSRS state in the shape the app stores in the history
-- ---------------------------------------------------------------------------

create or replace function public.card_fsrs_json(p_card public.card_states) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case when p_card.fsrs_due is null then null else jsonb_build_object(
    'due', p_card.fsrs_due,
    'stability', p_card.fsrs_stability,
    'difficulty', p_card.fsrs_difficulty,
    'last_review', p_card.fsrs_last_review,
    'reps', p_card.fsrs_reps,
    'lapses', p_card.fsrs_lapses,
    'state', p_card.fsrs_state,
    'scheduled_days', p_card.fsrs_scheduled_days,
    'learning_steps', p_card.fsrs_learning_steps,
    'version', p_card.fsrs_version
  ) end
$$;

revoke all on function public.card_fsrs_json(public.card_states) from anon, authenticated, public;
grant execute on function public.card_fsrs_json(public.card_states) to authenticated;

-- ---------------------------------------------------------------------------
-- Saving an answer under FSRS alone
-- ---------------------------------------------------------------------------

-- p_event:
--   vocabulary_id, request_id, action, reviewed_on   required
--   expected_revision                                required: the revision the reviewer saw
--   counts_toward_schedule                           default true
--   rating, version, after                           required when it counts: the FSRS
--                                                    rating and the state the app worked out
--   session_id, review_mode, reviewed_at, duration_ms, confidence   optional
--
-- Outcomes:
--   applied          saved; the state returned is the card's new one
--   already_applied  this request id was saved before; nothing changed now
--   undone           this request id was saved and then taken back
--   conflict         the card is not at the revision the reviewer saw; nothing changed
--   suspended        the card is archived; nothing changed
--   not_found        no such live word for this user
--
-- An answer that does not count is still recorded, but leaves the FSRS state,
-- the fallback day and the revision exactly as they were. Mastery and the
-- review date are never written: the history row repeats their frozen values.
create or replace function public.record_fsrs_review(p_event jsonb)
returns table (outcome text, revision bigint, due_on date, fsrs jsonb)
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
  v_reviewed_on date := (p_event ->> 'reviewed_on')::date;
  -- The moment the answer was given (it may have waited offline), never in the future.
  v_reviewed_at timestamptz := least(now(), coalesce((p_event ->> 'reviewed_at')::timestamptz, now()));
  v_duration integer := (p_event ->> 'duration_ms')::integer;
  v_confidence smallint := (p_event ->> 'confidence')::smallint;
  v_expected bigint := (p_event ->> 'expected_revision')::bigint;
  v_counts boolean := coalesce((p_event ->> 'counts_toward_schedule')::boolean, true);
  v_rating smallint := (p_event ->> 'rating')::smallint;
  v_version text := p_event ->> 'version';
  v_after jsonb := case when jsonb_typeof(p_event -> 'after') = 'object' then p_event -> 'after' end;
  v_card public.card_states;
  v_log public.review_logs;
  v_before jsonb;
  v_due_before date;
  v_new boolean;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_vocabulary is null or v_request is null or v_reviewed_on is null or v_expected is null
     or v_action not in ('remember', 'not_remember') then
    raise exception 'incomplete review event' using errcode = '22023';
  end if;
  if v_counts and (v_after is null or v_rating is null or v_rating not between 1 and 4 or v_version is null) then
    raise exception 'an answer that counts must carry its FSRS result' using errcode = '22023';
  end if;
  if v_confidence is not null and v_confidence not between 1 and 3 then
    raise exception 'confidence must be 1, 2 or 3' using errcode = '22023';
  end if;

  -- Holding the card's row makes two answers to the same card take turns.
  select c.* into v_card from public.card_states c
    join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
   where c.vocabulary_id = v_vocabulary and c.user_id = v_user and v.deleted_at is null
   for update of c;

  select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = v_request;
  if found then
    if v_log.kind <> 'review' then
      raise exception 'request id was used for another kind of event' using errcode = '22023';
    end if;
    if exists (select 1 from public.review_logs u where u.undoes_log_id = v_log.id) then
      return query select 'undone'::text, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
      return;
    end if;
    return query select 'already_applied'::text, v_log.revision_after, v_log.due_on_after, v_log.fsrs_after;
    return;
  end if;

  if v_card.vocabulary_id is null then
    return query select 'not_found'::text, null::bigint, null::date, null::jsonb;
    return;
  end if;
  if v_card.revision <> v_expected then
    return query select 'conflict'::text, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
    return;
  end if;
  if v_card.suspended_at is not null then
    return query select 'suspended'::text, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
    return;
  end if;

  if v_session is not null then
    insert into public.study_sessions (id, user_id, mode) values (v_session, v_user, v_mode)
      on conflict (id) do nothing;
    if not exists (select 1 from public.study_sessions s where s.id = v_session and s.user_id = v_user) then
      raise exception 'session belongs to another user' using errcode = '42501';
    end if;
  end if;

  v_before := public.card_fsrs_json(v_card);
  v_due_before := v_card.due_on;
  v_new := v_card.fsrs_due is null and not exists (
    select 1 from public.review_logs r
     where r.user_id = v_user and r.vocabulary_id = v_vocabulary and r.kind = 'review'
       and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id)
  );

  if v_counts then
    update public.card_states c
       set fsrs_due = (v_after ->> 'due')::timestamptz,
           fsrs_stability = (v_after ->> 'stability')::double precision,
           fsrs_difficulty = (v_after ->> 'difficulty')::double precision,
           fsrs_last_review = (v_after ->> 'last_review')::timestamptz,
           fsrs_reps = (v_after ->> 'reps')::integer,
           fsrs_lapses = (v_after ->> 'lapses')::integer,
           fsrs_state = (v_after ->> 'state')::smallint,
           fsrs_scheduled_days = (v_after ->> 'scheduled_days')::integer,
           fsrs_learning_steps = (v_after ->> 'learning_steps')::integer,
           fsrs_version = coalesce(v_after ->> 'version', v_version),
           due_on = null,
           revision = c.revision + 1
     where c.vocabulary_id = v_vocabulary and c.user_id = v_user
    returning * into v_card;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, kind, session_id, action, review_mode, reviewed_on, reviewed_at,
     duration_ms, mastery_before, mastery_after, review_date_before, review_date_after, scheduler,
     rating, fsrs_before, fsrs_after, fsrs_version, confidence,
     revision_before, revision_after, due_on_before, due_on_after, counted_toward_schedule, counted_as_new)
  values
    (v_user, v_vocabulary, v_request, 'review', v_session, v_action, v_mode, v_reviewed_on, v_reviewed_at,
     v_duration, v_card.mastery, v_card.mastery, v_card.review_date, v_card.review_date, 'fsrs',
     v_rating, v_before, case when v_counts then public.card_fsrs_json(v_card) else v_before end,
     coalesce(v_version, v_card.fsrs_version), v_confidence,
     v_expected, v_card.revision, v_due_before, v_card.due_on, v_counts, v_new);

  return query select 'applied'::text, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
end;
$$;

revoke all on function public.record_fsrs_review(jsonb) from anon, authenticated, public;
grant execute on function public.record_fsrs_review(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Taking an answer back under FSRS alone
-- ---------------------------------------------------------------------------

-- Only the card's latest standing answer can be taken back, and only while the
-- card is still at the revision that answer left it at. The FSRS state and the
-- fallback day go back to what they were; the revision moves on (never back),
-- so a device still holding the undone state cannot write over it.
--
-- An answer saved before version 15 is taken back by the version 8 function,
-- and the revision moved on in the same transaction.
create or replace function public.undo_fsrs_review(p_review_request_id uuid, p_request_id uuid)
returns table (outcome text, vocabulary_id uuid, revision bigint, due_on date, fsrs jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_target public.review_logs;
  v_undo public.review_logs;
  v_card public.card_states;
  v_prior jsonb;
  v_due_before date;
  v_revision_before bigint;
  v_legacy text;
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
    return query select 'not_found'::text, null::uuid, null::bigint, null::date, null::jsonb;
    return;
  end if;

  select c.* into v_card from public.card_states c
    join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
   where c.vocabulary_id = v_target.vocabulary_id and c.user_id = v_user and v.deleted_at is null
   for update of c;

  select * into v_undo from public.review_logs l where l.user_id = v_user and l.request_id = p_request_id;
  if found and (v_undo.kind <> 'undo' or v_undo.undoes_log_id <> v_target.id) then
    raise exception 'request id was used for another event' using errcode = '22023';
  end if;
  if not found then
    select * into v_undo from public.review_logs l where l.undoes_log_id = v_target.id;
  end if;
  if found then
    return query select 'already_undone'::text, v_target.vocabulary_id, v_card.revision, v_card.due_on,
      public.card_fsrs_json(v_card);
    return;
  end if;

  if v_card.vocabulary_id is null then
    return query select 'conflict'::text, v_target.vocabulary_id, null::bigint, null::date, null::jsonb;
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
    return query select 'not_latest'::text, v_target.vocabulary_id, v_card.revision, v_card.due_on,
      public.card_fsrs_json(v_card);
    return;
  end if;

  -- Saved before version 15: the version 8 function knows how to take it back.
  if v_target.revision_after is null then
    select u.outcome into v_legacy from public.undo_review(p_review_request_id, p_request_id) u;
    if v_legacy = 'undone' then
      update public.card_states c set revision = c.revision + 1
       where c.vocabulary_id = v_target.vocabulary_id and c.user_id = v_user
      returning * into v_card;
    end if;
    return query select v_legacy, v_target.vocabulary_id, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
    return;
  end if;

  if v_card.revision <> v_target.revision_after then
    return query select 'conflict'::text, v_target.vocabulary_id, v_card.revision, v_card.due_on,
      public.card_fsrs_json(v_card);
    return;
  end if;

  v_revision_before := v_card.revision;
  v_due_before := v_card.due_on;
  if v_target.counted_toward_schedule is distinct from false then
    v_prior := case when jsonb_typeof(v_target.fsrs_before) = 'object' then v_target.fsrs_before end;
    update public.card_states c
       set fsrs_due = (v_prior ->> 'due')::timestamptz,
           fsrs_stability = (v_prior ->> 'stability')::double precision,
           fsrs_difficulty = (v_prior ->> 'difficulty')::double precision,
           fsrs_last_review = (v_prior ->> 'last_review')::timestamptz,
           fsrs_reps = (v_prior ->> 'reps')::integer,
           fsrs_lapses = (v_prior ->> 'lapses')::integer,
           fsrs_state = (v_prior ->> 'state')::smallint,
           fsrs_scheduled_days = (v_prior ->> 'scheduled_days')::integer,
           fsrs_learning_steps = (v_prior ->> 'learning_steps')::integer,
           fsrs_version = v_prior ->> 'version',
           due_on = v_target.due_on_before,
           revision = c.revision + 1
     where c.vocabulary_id = v_target.vocabulary_id and c.user_id = v_user
    returning * into v_card;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, kind, undoes_log_id, session_id, action, review_mode, reviewed_on,
     mastery_before, mastery_after, review_date_before, review_date_after, scheduler,
     rating, fsrs_before, fsrs_after, fsrs_version,
     revision_before, revision_after, due_on_before, due_on_after, counted_toward_schedule)
  values
    (v_user, v_target.vocabulary_id, p_request_id, 'undo', v_target.id, v_target.session_id, v_target.action,
     v_target.review_mode, v_target.reviewed_on,
     v_card.mastery, v_card.mastery, v_card.review_date, v_card.review_date, 'fsrs',
     v_target.rating, v_target.fsrs_after, public.card_fsrs_json(v_card), v_target.fsrs_version,
     v_revision_before, v_card.revision, v_due_before, v_card.due_on, v_target.counted_toward_schedule);

  return query select 'undone'::text, v_target.vocabulary_id, v_card.revision, v_card.due_on, public.card_fsrs_json(v_card);
end;
$$;

revoke all on function public.undo_fsrs_review(uuid, uuid) from anon, authenticated, public;
grant execute on function public.undo_fsrs_review(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Archiving and resuming words, in bulk
-- ---------------------------------------------------------------------------

-- Archived words stay in the Bank (under the Archived filter) and keep their
-- FSRS state, but leave the review queue and the dashboard. Moving the
-- revision on means an answer prepared before the change is refused.
-- Returns the words that actually changed.
create or replace function public.set_cards_suspended(p_ids uuid[], p_suspended boolean)
returns table (vocabulary_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_ids is null or p_suspended is null or cardinality(p_ids) > 500 then
    raise exception 'between 1 and 500 words, and archive or resume' using errcode = '22023';
  end if;

  return query
  update public.card_states c
     set suspended_at = case when p_suspended then now() end,
         suspended_reason = case when p_suspended then 'archived' end,
         revision = c.revision + 1
   where c.user_id = v_user
     and c.vocabulary_id = any (p_ids)
     and (c.suspended_at is null) = p_suspended
     and exists (select 1 from public.vocabulary v
                  where v.id = c.vocabulary_id and v.user_id = v_user and v.deleted_at is null)
  returning c.vocabulary_id;
end;
$$;

revoke all on function public.set_cards_suspended(uuid[], boolean) from anon, authenticated, public;
grant execute on function public.set_cards_suspended(uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The two daily goals and the streak
-- ---------------------------------------------------------------------------

-- One row per day the goals were looked at: what was done, against which
-- goals, and whether both were met. A day that was met stays met, and a goal
-- changed later never rewrites an earlier day. The streak is the run of met days.
create table if not exists public.study_days (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  new_words integer not null default 0 check (new_words >= 0),
  reviews integer not null default 0 check (reviews >= 0),
  practice integer not null default 0 check (practice >= 0),
  new_goal integer not null check (new_goal between 0 and 1000),
  review_goal integer not null check (review_goal between 0 and 1000),
  practice_goal integer not null check (practice_goal between 0 and 1000),
  met boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- A table made by an earlier form of this file has no practice columns; days
-- recorded then had no practice goal to meet.
alter table public.study_days
  add column if not exists practice integer not null default 0 check (practice >= 0),
  add column if not exists practice_goal integer not null default 0 check (practice_goal between 0 and 1000);

alter table public.study_days enable row level security;

drop policy if exists study_days_select on public.study_days;
create policy study_days_select on public.study_days for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists study_days_insert on public.study_days;
create policy study_days_insert on public.study_days for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists study_days_update on public.study_days;
create policy study_days_update on public.study_days for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.study_days from anon, authenticated, public;
grant select, insert, update on public.study_days to authenticated;

drop trigger if exists study_days_touch on public.study_days;
create trigger study_days_touch before update on public.study_days
  for each row execute function public.touch_updated_at();

-- What one day of the caller's study counts towards the goals, from the
-- answers saved under FSRS alone that still stand:
--   new_words  words brought into study that day (their first answer ever)
--   reviews    other words answered that day that were due when answered
--   practice   practice answers given that day
-- A database that ran an earlier form of this file has the old result shape.
drop function if exists public.study_day_counts(date);

create function public.study_day_counts(p_day date)
returns table (new_words integer, reviews integer, practice integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with zone as (
    select coalesce(
      (select s.time_zone from public.user_settings s where s.user_id = (select auth.uid())),
      'UTC'
    ) as name
  ),
  answers as (
    select
      l.vocabulary_id,
      coalesce(l.counted_as_new, false) as is_new,
      case
        when coalesce(l.counted_as_new, false) then false
        when jsonb_typeof(l.fsrs_before) = 'object'
          then (l.fsrs_before ->> 'due')::timestamptz < ((l.reviewed_on + 1)::timestamp at time zone (select z.name from zone z))
        else l.due_on_before is null or l.due_on_before <= l.reviewed_on
      end as was_due
    from public.review_logs l
    where l.user_id = (select auth.uid())
      and l.kind = 'review'
      and l.reviewed_on = p_day
      and l.revision_after is not null
      and not exists (select 1 from public.review_logs u where u.undoes_log_id = l.id)
  ),
  counts as (
    select
      (count(distinct a.vocabulary_id) filter (where a.is_new))::integer as nw,
      (count(distinct a.vocabulary_id) filter (where a.was_due))::integer as rev
    from answers a
  ),
  prac as (
    select count(*)::integer as p
    from public.review_logs l
    where l.user_id = (select auth.uid())
      and l.kind = 'practice'
      and l.reviewed_on = p_day
  )
  select c.nw, c.rev, p.p
  from counts c, prac p
$$;

revoke all on function public.study_day_counts(date) from anon, authenticated, public;
grant execute on function public.study_day_counts(date) to authenticated;

-- Records how a day stands. `met` only ever goes from false to true.
-- Returns whether the day is met now.
create or replace function public.record_study_day(
  p_day date,
  p_new_words integer,
  p_reviews integer,
  p_practice integer,
  p_new_goal integer,
  p_review_goal integer,
  p_practice_goal integer,
  p_met boolean
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  insert into public.study_days as d (user_id, day, new_words, reviews, practice, new_goal, review_goal, practice_goal, met)
  values ((select auth.uid()), p_day, p_new_words, p_reviews, p_practice, p_new_goal, p_review_goal, p_practice_goal, p_met)
  on conflict (user_id, day) do update
    set new_words = excluded.new_words,
        reviews = excluded.reviews,
        practice = excluded.practice,
        new_goal = excluded.new_goal,
        review_goal = excluded.review_goal,
        practice_goal = excluded.practice_goal,
        met = d.met or excluded.met
  returning d.met
$$;

revoke all on function public.record_study_day(date, integer, integer, integer, integer, integer, integer, boolean) from anon, authenticated, public;
grant execute on function public.record_study_day(date, integer, integer, integer, integer, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- One-off: every studied word gets an FSRS state
-- ---------------------------------------------------------------------------

-- A word that has been studied (mastery above the starting 1, or any standing
-- review) but has no FSRS state gets an estimate from its mastery, marked with
-- the version 'legacy-mapped'. After its next answer FSRS carries on from there.
--
--   mastery   0-1   2   3   4    5    6    7     8     9    10
--   stability 0.5   1   3   7   14   30   60   120   240   365  (days)
--
-- The due day is the old review day (at the start of that day in the
-- reviewer's time zone), or now when there was none; a past day is due at
-- once. The last review is the latest standing answer, or else the moment
-- that leaves the card exactly one stability before its due time. Words never
-- studied, and words that already have an FSRS state, are left as they are.
with history as (
  select l.vocabulary_id, l.user_id, max(l.reviewed_at) as last_reviewed
    from public.review_logs l
   where l.kind = 'review'
     and not exists (select 1 from public.review_logs u where u.undoes_log_id = l.id)
   group by l.vocabulary_id, l.user_id
),
targets as (
  select
    c.vocabulary_id,
    c.user_id,
    h.last_reviewed,
    case greatest(c.mastery, 1)
      when 1 then 0.5 when 2 then 1 when 3 then 3 when 4 then 7 when 5 then 14
      when 6 then 30 when 7 then 60 when 8 then 120 when 9 then 240 else 365
    end::double precision as stability,
    case when c.review_date is null then now()
         else (c.review_date::timestamp at time zone coalesce(s.time_zone, 'UTC')) end as due
    from public.card_states c
    left join history h on h.vocabulary_id = c.vocabulary_id and h.user_id = c.user_id
    left join public.user_settings s on s.user_id = c.user_id
   where c.fsrs_due is null
     and (c.mastery > 1 or h.last_reviewed is not null)
),
estimated as (
  select t.*,
         -- `least` skips nulls, so the case is spelled out: no answer on record means one stability back.
         case when t.last_reviewed is null then t.due - make_interval(secs => t.stability * 86400)
              else least(t.last_reviewed, t.due) end as last_review
    from targets t
)
update public.card_states c
   set fsrs_stability = e.stability,
       fsrs_difficulty = 5,
       fsrs_state = 2,
       fsrs_reps = 0,
       fsrs_lapses = 0,
       fsrs_learning_steps = 0,
       fsrs_due = e.due,
       fsrs_last_review = e.last_review,
       fsrs_scheduled_days = greatest(0, round(extract(epoch from (e.due - e.last_review)) / 86400))::integer,
       fsrs_version = 'legacy-mapped',
       due_on = null
  from estimated e
 where c.vocabulary_id = e.vocabulary_id and c.user_id = e.user_id and c.fsrs_due is null;

-- Words never studied keep their review day as the day they first come up.
update public.card_states c
   set due_on = c.review_date
 where c.fsrs_due is null and c.due_on is null and c.review_date is not null;
