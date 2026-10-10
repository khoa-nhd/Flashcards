-- Schema version 2: review sessions, Undo, and a session summary.
--
-- Additive only. The app as it ran before this file keeps working unchanged:
-- public.apply_review is left exactly as it was. Run this file once.

-- ---------------------------------------------------------------------------
-- Schema version marker
-- ---------------------------------------------------------------------------

-- The server asks for this before using anything newer than the first
-- migration, so code deployed ahead of a migration never calls what is not
-- there. Each later migration replaces it with a higher number.
create function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 2 $$;

revoke all on function public.app_schema_version() from anon, authenticated, public;
grant execute on function public.app_schema_version() to authenticated;

-- ---------------------------------------------------------------------------
-- Study sessions
-- ---------------------------------------------------------------------------

-- One sitting of reviewing. The id is chosen by the browser, so the first
-- saved answer can create the session in the same transaction.
create table public.study_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null default 'flashcard' check (char_length(mode) between 1 and 40),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint study_sessions_id_user_key unique (id, user_id)
);

create index study_sessions_user_time_idx on public.study_sessions (user_id, started_at desc);

alter table public.study_sessions enable row level security;

create policy study_sessions_select on public.study_sessions for select to authenticated
  using (user_id = (select auth.uid()));
create policy study_sessions_insert on public.study_sessions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy study_sessions_update on public.study_sessions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.study_sessions from anon, authenticated, public;
grant select, insert, update on public.study_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- Review history: sessions and undo events
-- ---------------------------------------------------------------------------

alter table public.review_logs
  add constraint review_logs_id_user_key unique (id, user_id);

alter table public.review_logs
  -- 'review' is an answer. 'undo' reverses one earlier answer; it is a new row,
  -- so the history still shows both what happened and that it was taken back.
  add column kind text not null default 'review' check (kind in ('review', 'undo')),
  add column session_id uuid,
  add column undoes_log_id uuid;

alter table public.review_logs
  add constraint review_logs_session_fkey foreign key (session_id, user_id)
    references public.study_sessions (id, user_id) on delete cascade,
  -- An undo can only point at a row of the same user.
  add constraint review_logs_undoes_fkey foreign key (undoes_log_id, user_id)
    references public.review_logs (id, user_id) on delete cascade,
  add constraint review_logs_undo_shape check ((kind = 'undo') = (undoes_log_id is not null));

-- An answer can be undone at most once.
create unique index review_logs_one_undo_idx on public.review_logs (undoes_log_id)
  where undoes_log_id is not null;
create index review_logs_user_day_idx on public.review_logs (user_id, reviewed_on);
create index review_logs_session_idx on public.review_logs (session_id) where session_id is not null;

-- Answers that still stand: reviews that were not undone. Everything that
-- counts reviews reads this, never the raw table.
create view public.effective_reviews with (security_invoker = true) as
select r.*
  from public.review_logs r
 where r.kind = 'review'
   and not exists (select 1 from public.review_logs u where u.undoes_log_id = r.id);

revoke all on public.effective_reviews from anon, authenticated, public;
grant select on public.effective_reviews to authenticated;

-- ---------------------------------------------------------------------------
-- Saving an answer (replaces apply_review for servers that know version 2)
-- ---------------------------------------------------------------------------

-- Takes one JSON event so that later versions can add fields without changing
-- the function's signature. Outcomes:
--
--   applied          the state matched what the reviewer saw and was updated
--   already_applied  this request id was recorded before; nothing changed now
--   undone           this request id was recorded and later undone
--   conflict         the state is no longer what the reviewer saw; nothing changed
--   not_found        no such live word for this user
create function public.record_review(p_event jsonb)
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
    -- The id already exists but is not this user's: refuse rather than attach to it.
    if not exists (select 1 from public.study_sessions s where s.id = v_session and s.user_id = v_user) then
      raise exception 'session belongs to another user' using errcode = '42501';
    end if;
  end if;

  -- The WHERE clause is the compare-and-set: of two answers given at the same
  -- moment on two devices, the second finds the state already changed.
  update public.card_states c
     set mastery = v_new_mastery, review_date = v_new_date
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
     mastery_before, mastery_after, review_date_before, review_date_after)
  values
    (v_user, v_vocabulary, v_request, 'review', v_session, v_action, v_mode, v_reviewed_on, v_duration,
     v_expected_mastery, v_new_mastery, v_expected_date, v_new_date);

  return query select 'applied'::text, v_state.mastery, v_state.review_date;
end;
$$;

-- ---------------------------------------------------------------------------
-- Undoing an answer
-- ---------------------------------------------------------------------------

-- Reverses one named answer, identified by the request id it was saved with.
-- Nothing is deleted: the card's state goes back to what it was before that
-- answer, and an 'undo' row is appended. Both happen, or neither.
--
--   undone          the answer was reversed now
--   already_undone  it had been reversed before; nothing changed now
--   not_latest      the card has a newer answer that still stands; nothing changed
--   conflict        the card no longer holds the state that answer left (it was
--                   edited, or trashed); nothing changed
--   not_found       this user has no such answer
create function public.undo_review(p_review_request_id uuid, p_request_id uuid)
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

  -- The undo request itself repeated, or the answer undone by an earlier request.
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

  -- Compare-and-set again: only a card still in the state this answer left is restored.
  update public.card_states c
     set mastery = v_target.mastery_before, review_date = v_target.review_date_before
   where c.vocabulary_id = v_target.vocabulary_id
     and c.user_id = v_user
     and c.mastery = v_target.mastery_after
     and c.review_date is not distinct from v_target.review_date_after
     and exists (select 1 from public.vocabulary v
                  where v.id = v_target.vocabulary_id and v.user_id = v_user and v.deleted_at is null)
  returning * into v_state;

  if not found then
    -- The same undo may have been committed by a concurrent call.
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
     mastery_before, mastery_after, review_date_before, review_date_after, scheduler)
  values
    (v_user, v_target.vocabulary_id, p_request_id, 'undo', v_target.id, v_target.session_id, v_target.action,
     v_target.review_mode, v_target.reviewed_on,
     v_target.mastery_after, v_target.mastery_before, v_target.review_date_after, v_target.review_date_before,
     v_target.scheduler);

  return query select 'undone'::text, v_target.vocabulary_id, v_state.mastery, v_state.review_date;
end;
$$;

-- ---------------------------------------------------------------------------
-- Session summary
-- ---------------------------------------------------------------------------

-- What one session actually saved. Counts only answers that still stand, so an
-- undone answer and an answer that never reached the database are both absent.
-- Returns no row for a session that is not the caller's.
create function public.session_summary(p_session_id uuid)
returns table (
  session_id uuid,
  started_at timestamptz,
  last_review_at timestamptz,
  reviewed integer,
  remembered integer,
  not_remembered integer,
  -- Answers that were the first recorded review of their card.
  first_time integer,
  undone integer,
  duration_ms bigint,
  -- How many of the answers have a duration, so an average is never taken over the wrong count.
  timed_reviews integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with standing as (
    select e.* from public.effective_reviews e
     where e.user_id = (select auth.uid()) and e.session_id = p_session_id
  )
  select
    s.id,
    s.started_at,
    (select max(x.reviewed_at) from standing x),
    (select count(*)::integer from standing),
    (select count(*)::integer from standing x where x.action = 'remember'),
    (select count(*)::integer from standing x where x.action = 'not_remember'),
    (select count(*)::integer from standing x
      where not exists (
        select 1 from public.effective_reviews p
         where p.user_id = x.user_id
           and p.vocabulary_id = x.vocabulary_id
           and (p.reviewed_at, p.id) < (x.reviewed_at, x.id))),
    (select count(*)::integer from public.review_logs u
      where u.user_id = (select auth.uid()) and u.session_id = p_session_id and u.kind = 'undo'),
    (select coalesce(sum(x.duration_ms), 0)::bigint from standing x),
    (select count(*)::integer from standing x where x.duration_ms is not null)
  from public.study_sessions s
 where s.id = p_session_id and s.user_id = (select auth.uid());
$$;

revoke all on function public.record_review(jsonb) from anon, authenticated, public;
revoke all on function public.undo_review(uuid, uuid) from anon, authenticated, public;
revoke all on function public.session_summary(uuid) from anon, authenticated, public;
grant execute on function public.record_review(jsonb) to authenticated;
grant execute on function public.undo_review(uuid, uuid) to authenticated;
grant execute on function public.session_summary(uuid) to authenticated;
