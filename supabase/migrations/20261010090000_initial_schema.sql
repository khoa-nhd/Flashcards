-- Vocabulary app: initial schema.
--
-- Every row belongs to exactly one user and is reachable only by that user.
-- Ownership is enforced three ways that do not depend on application code:
--   1. Row Level Security on every table.
--   2. `user_id` defaults to the caller and RLS rejects any other value.
--   3. Composite foreign keys (id, user_id), so a card state or review log can
--      never point at another user's word.
--
-- Scheduling state lives in card_states, apart from the word itself, and
-- carries unused FSRS columns so a later scheduler can be added without
-- reshaping the data. Nothing in this migration activates FSRS.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.vocabulary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  word text not null check (char_length(btrim(word)) between 1 and 200),
  -- The word trimmed, single-spaced and lower-cased by the application, which
  -- is the one place "same word" is defined. Used to look up possible duplicates.
  word_key text not null check (char_length(word_key) between 1 and 200),
  meaning text check (meaning is null or char_length(meaning) between 1 and 6000),
  definition text check (definition is null or char_length(definition) between 1 and 6000),
  example text check (example is null or char_length(example) between 1 and 6000),
  -- A calendar day chosen by the user, not an instant.
  date_added date,
  -- Where an imported row came from. Makes a repeated import a no-op.
  external_source text,
  external_id text,
  -- Identifies the submission that created the row, so a retried request
  -- returns the first result instead of creating a second word.
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft delete: a trashed word keeps its data and can be restored.
  deleted_at timestamptz,
  constraint vocabulary_id_user_key unique (id, user_id),
  constraint vocabulary_external_key unique (user_id, external_source, external_id),
  constraint vocabulary_request_key unique (user_id, request_id),
  constraint vocabulary_external_pair check ((external_source is null) = (external_id is null))
);

create index vocabulary_live_idx on public.vocabulary (user_id, created_at) where deleted_at is null;
create index vocabulary_word_key_idx on public.vocabulary (user_id, word_key) where deleted_at is null;
create index vocabulary_date_added_idx on public.vocabulary (user_id, date_added) where deleted_at is null;

create table public.card_states (
  vocabulary_id uuid primary key,
  user_id uuid not null default auth.uid(),
  -- The scheduler in use today: a mastery level and the next review day.
  mastery smallint not null check (mastery between 0 and 10),
  review_date date,
  scheduler text not null default 'mastery_v1',
  -- Reserved for FSRS. Null until that scheduler is adopted; never back-filled
  -- with invented history.
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_due timestamptz,
  fsrs_last_review timestamptz,
  fsrs_reps integer check (fsrs_reps is null or fsrs_reps >= 0),
  fsrs_lapses integer check (fsrs_lapses is null or fsrs_lapses >= 0),
  fsrs_state smallint,
  fsrs_version text,
  updated_at timestamptz not null default now(),
  constraint card_states_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade
);

create index card_states_due_idx on public.card_states (user_id, review_date) where mastery < 10;

-- Append-only history of review answers. One row per answer, never updated.
create table public.review_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  vocabulary_id uuid not null,
  -- Supplied by the client once per answer. The unique constraint below is
  -- what makes a retried answer harmless.
  request_id uuid not null,
  action text not null check (action in ('remember', 'not_remember')),
  review_mode text not null default 'flashcard',
  reviewed_at timestamptz not null default now(),
  -- The user's calendar day the schedule was computed from.
  reviewed_on date not null,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  mastery_before smallint not null,
  mastery_after smallint not null,
  review_date_before date,
  review_date_after date,
  scheduler text not null default 'mastery_v1',
  constraint review_logs_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade,
  constraint review_logs_request_key unique (user_id, request_id)
);

create index review_logs_user_time_idx on public.review_logs (user_id, reviewed_at desc);
create index review_logs_vocabulary_idx on public.review_logs (vocabulary_id, reviewed_at desc);

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- IANA zone that decides which calendar day is "today" for this user.
  time_zone text not null default 'UTC' check (char_length(time_zone) between 1 and 64),
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger vocabulary_touch before update on public.vocabulary
  for each row execute function public.touch_updated_at();
create trigger card_states_touch before update on public.card_states
  for each row execute function public.touch_updated_at();
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.vocabulary enable row level security;
alter table public.card_states enable row level security;
alter table public.review_logs enable row level security;
alter table public.user_settings enable row level security;

create policy vocabulary_select on public.vocabulary for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_insert on public.vocabulary for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_update on public.vocabulary for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy card_states_select on public.card_states for select to authenticated
  using (user_id = (select auth.uid()));
create policy card_states_insert on public.card_states for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy card_states_update on public.card_states for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- There is deliberately no DELETE policy on words or their states. The app
-- "deletes" by setting deleted_at, which can be undone; removing a row would
-- also remove its review history. Rows only ever go when the account itself
-- is deleted, through the cascade from auth.users.

-- History can be read and appended to by its owner, and nothing else.
create policy review_logs_select on public.review_logs for select to authenticated
  using (user_id = (select auth.uid()));
create policy review_logs_insert on public.review_logs for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy user_settings_select on public.user_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy user_settings_insert on public.user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy user_settings_update on public.user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Privileges. Start from nothing, because a hosted project grants broad defaults
-- on new tables, then give signed-in users exactly what the app needs.
-- Signed-out visitors (anon) get nothing at all.
revoke all on public.vocabulary, public.card_states, public.review_logs, public.user_settings
  from anon, authenticated, public;
grant select, insert, update on public.vocabulary, public.card_states to authenticated;
grant select, insert on public.review_logs to authenticated;
grant select, insert, update on public.user_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Reading: one row per word with its scheduling state
-- ---------------------------------------------------------------------------

-- security_invoker makes the view obey the caller's RLS rather than its owner's.
create view public.vocabulary_cards with (security_invoker = true) as
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
  c.review_date
from public.vocabulary v
join public.card_states c on c.vocabulary_id = v.id and c.user_id = v.user_id;

revoke all on public.vocabulary_cards from anon, authenticated, public;
grant select on public.vocabulary_cards to authenticated;

-- ---------------------------------------------------------------------------
-- Writing: operations that must be all-or-nothing
-- ---------------------------------------------------------------------------

-- Creates a word together with its scheduling state. A repeated request id, or
-- a repeated (source, id) pair from an import, returns the existing word.
create function public.create_vocabulary(
  p_word text,
  p_word_key text,
  p_mastery smallint,
  p_meaning text default null,
  p_definition text default null,
  p_example text default null,
  p_date_added date default null,
  p_review_date date default null,
  p_request_id uuid default null,
  p_external_source text default null,
  p_external_id text default null,
  p_created_at timestamptz default null
) returns table (id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_request_id is not null then
    select v.id into v_id from public.vocabulary v where v.user_id = v_user and v.request_id = p_request_id;
    if found then
      return query select v_id, false;
      return;
    end if;
  end if;

  if p_external_id is not null then
    select v.id into v_id from public.vocabulary v
     where v.user_id = v_user and v.external_source = p_external_source and v.external_id = p_external_id;
    if found then
      return query select v_id, false;
      return;
    end if;
  end if;

  insert into public.vocabulary
    (user_id, word, word_key, meaning, definition, example, date_added, request_id, external_source, external_id, created_at)
  values
    (v_user, p_word, p_word_key, p_meaning, p_definition, p_example, p_date_added, p_request_id,
     p_external_source, p_external_id, coalesce(p_created_at, now()))
  returning vocabulary.id into v_id;

  insert into public.card_states (vocabulary_id, user_id, mastery, review_date)
  values (v_id, v_user, p_mastery, p_review_date);

  return query select v_id, true;
exception
  -- Two identical submissions raced; the other one won. Report its row.
  when unique_violation then
    select v.id into v_id from public.vocabulary v
     where v.user_id = v_user
       and ((p_request_id is not null and v.request_id = p_request_id)
         or (p_external_id is not null and v.external_source = p_external_source and v.external_id = p_external_id));
    if not found then
      raise;
    end if;
    return query select v_id, false;
end;
$$;

-- Applies a partial edit in one transaction. Only the keys present in p_patch
-- are written; a JSON null clears a value. Unknown keys are rejected.
create function public.update_vocabulary(p_id uuid, p_patch jsonb) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_text_changed boolean := false;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('word', 'word_key', 'meaning', 'definition', 'example', 'date_added', 'mastery', 'review_date') then
      raise exception 'unknown field: %', v_key using errcode = '22023';
    end if;
  end loop;

  if p_patch ?| array['word', 'word_key', 'meaning', 'definition', 'example', 'date_added'] then
    update public.vocabulary v set
      word = case when p_patch ? 'word' then p_patch ->> 'word' else v.word end,
      word_key = case when p_patch ? 'word_key' then p_patch ->> 'word_key' else v.word_key end,
      meaning = case when p_patch ? 'meaning' then p_patch ->> 'meaning' else v.meaning end,
      definition = case when p_patch ? 'definition' then p_patch ->> 'definition' else v.definition end,
      example = case when p_patch ? 'example' then p_patch ->> 'example' else v.example end,
      date_added = case when p_patch ? 'date_added' then (p_patch ->> 'date_added')::date else v.date_added end
    where v.id = p_id and v.user_id = v_user and v.deleted_at is null;
    if not found then
      return false;
    end if;
    v_text_changed := true;
  end if;

  if p_patch ?| array['mastery', 'review_date'] then
    update public.card_states c set
      mastery = case when p_patch ? 'mastery' then (p_patch ->> 'mastery')::smallint else c.mastery end,
      review_date = case when p_patch ? 'review_date' then (p_patch ->> 'review_date')::date else c.review_date end
    where c.vocabulary_id = p_id and c.user_id = v_user
      and exists (select 1 from public.vocabulary v where v.id = p_id and v.user_id = v_user and v.deleted_at is null);
    if not found then
      if v_text_changed then
        -- Raising, not returning, so the text change above is rolled back too.
        raise exception 'scheduling state is missing for this word' using errcode = 'P0002';
      end if;
      return false;
    end if;
  end if;

  return true;
end;
$$;

-- Records one review answer: moves the scheduling state from what the reviewer
-- saw to the new values and appends the history row, or does neither.
--
--   applied          the state matched p_expected_* and was updated
--   already_applied  this request id was recorded before; nothing changed now
--   conflict         the state is no longer what the reviewer saw; nothing changed
--   not_found        no such live word for this user
--
-- The new values are computed by the application's scheduler and passed in, so
-- the scheduling rule is defined in exactly one place.
create function public.apply_review(
  p_vocabulary_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_mastery smallint,
  p_expected_review_date date,
  p_new_mastery smallint,
  p_new_review_date date,
  p_reviewed_on date,
  p_duration_ms integer default null,
  p_review_mode text default 'flashcard'
) returns table (outcome text, mastery smallint, review_date date)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_log public.review_logs;
  v_state public.card_states;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = p_request_id;
  if found then
    return query select 'already_applied'::text, v_log.mastery_after, v_log.review_date_after;
    return;
  end if;

  -- The WHERE clause is the compare-and-set: of two answers given at the same
  -- moment on two devices, the second finds the state already changed.
  update public.card_states c
     set mastery = p_new_mastery, review_date = p_new_review_date
   where c.vocabulary_id = p_vocabulary_id
     and c.user_id = v_user
     and c.mastery = p_expected_mastery
     and c.review_date is not distinct from p_expected_review_date
     and exists (select 1 from public.vocabulary v
                  where v.id = p_vocabulary_id and v.user_id = v_user and v.deleted_at is null)
  returning * into v_state;

  if not found then
    -- The same request may have been applied by a concurrent call that
    -- committed while this one was waiting on the row.
    select * into v_log from public.review_logs l where l.user_id = v_user and l.request_id = p_request_id;
    if found then
      return query select 'already_applied'::text, v_log.mastery_after, v_log.review_date_after;
      return;
    end if;

    select c.* into v_state from public.card_states c
      join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
     where c.vocabulary_id = p_vocabulary_id and c.user_id = v_user and v.deleted_at is null;
    if not found then
      return query select 'not_found'::text, null::smallint, null::date;
      return;
    end if;
    return query select 'conflict'::text, v_state.mastery, v_state.review_date;
    return;
  end if;

  insert into public.review_logs
    (user_id, vocabulary_id, request_id, action, review_mode, reviewed_on, duration_ms,
     mastery_before, mastery_after, review_date_before, review_date_after)
  values
    (v_user, p_vocabulary_id, p_request_id, p_action, p_review_mode, p_reviewed_on, p_duration_ms,
     p_expected_mastery, p_new_mastery, p_expected_review_date, p_new_review_date);

  return query select 'applied'::text, v_state.mastery, v_state.review_date;
end;
$$;

revoke all on function public.create_vocabulary(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz) from anon, authenticated, public;
revoke all on function public.update_vocabulary(uuid, jsonb) from anon, authenticated, public;
revoke all on function public.apply_review(uuid, uuid, text, smallint, date, smallint, date, date, integer, text) from anon, authenticated, public;
grant execute on function public.create_vocabulary(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz) to authenticated;
grant execute on function public.update_vocabulary(uuid, jsonb) to authenticated;
grant execute on function public.apply_review(uuid, uuid, text, smallint, date, smallint, date, date, integer, text) to authenticated;
