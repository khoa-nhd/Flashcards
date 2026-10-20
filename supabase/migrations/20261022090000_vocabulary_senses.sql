-- Schema version 13: vocabulary senses.
--
-- A vocabulary entry can now have multiple senses (meanings). Each sense has
-- its own meaning, definition, and example. Senses are ordered and have stable
-- identities so that learning evidence can reference them in the future.
--
-- Senses are changed only through the operation endpoints (add / update /
-- reorder / archive / restore), each of which carries its own optimistic-lock
-- version and, for adding, a request id so a retry lands once. Removal is
-- archiving: a sense is never deleted. The shown meaning, definition and
-- example remain the first sense that is not archived, so every older reader
-- keeps working unchanged.
--
-- Additive only; run this file once, after the version 12 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 13 $$;

-- ---------------------------------------------------------------------------
-- vocabulary_senses table
-- ---------------------------------------------------------------------------

create table public.vocabulary_senses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  vocabulary_id uuid not null,
  position smallint not null check (position >= 0),
  meaning text check (meaning is null or char_length(meaning) between 1 and 6000),
  definition text check (definition is null or char_length(definition) between 1 and 6000),
  example text check (example is null or char_length(example) between 1 and 6000),
  archived_at timestamptz,
  version integer not null default 1,
  -- Identifies the submission that created the sense, so a retry lands once.
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vocabulary_senses_vocabulary_fkey
    foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade,
  constraint vocabulary_senses_position_unique unique (vocabulary_id, position)
);

create index vocabulary_senses_vocab_user_idx on public.vocabulary_senses (vocabulary_id, user_id);
-- A retried "add sense" carries the same request id: it finds the sense that landed.
create unique index vocabulary_senses_request_unique
  on public.vocabulary_senses (user_id, request_id) where request_id is not null;

create trigger vocabulary_senses_touch before update on public.vocabulary_senses
  for each row execute function public.touch_updated_at();

-- Every sense change moves the word's senses_version, so a client holding an
-- older version is told to reload before it reorders or edits again.
create or replace function public.vocabulary_senses_bump_version() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.vocabulary set senses_version = senses_version + 1
   where id = coalesce(new.vocabulary_id, old.vocabulary_id)
     and user_id = coalesce(new.user_id, old.user_id);
  return coalesce(new, old);
end;
$$;

create trigger vocabulary_senses_version
  after insert or update or delete on public.vocabulary_senses
  for each row execute function public.vocabulary_senses_bump_version();

alter table public.vocabulary_senses enable row level security;

create policy vocabulary_senses_select on public.vocabulary_senses for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_senses_insert on public.vocabulary_senses for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_senses_update on public.vocabulary_senses for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- No delete policy: senses are archived, never removed. The only hard delete
-- is the cascade from the word itself, which runs without needing one.

revoke all on public.vocabulary_senses from anon, authenticated, public;
grant select, insert, update on public.vocabulary_senses to authenticated;

-- ---------------------------------------------------------------------------
-- senses_version column on vocabulary for optimistic locking
-- ---------------------------------------------------------------------------

alter table public.vocabulary
  add column senses_version integer not null default 0;

-- ---------------------------------------------------------------------------
-- Backfill: create a primary sense (position 0) for every existing vocabulary
-- row that has any content. Content-free rows get no sense row (minimal profile).
-- Soft-deleted rows are included so restore works correctly.
-- ---------------------------------------------------------------------------

insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example)
select v.user_id, v.id, 0, v.meaning, v.definition, v.example
from public.vocabulary v
where v.meaning is not null or v.definition is not null or v.example is not null;

-- ---------------------------------------------------------------------------
-- Updated view: vocabulary_cards with senses jsonb column appended
-- ---------------------------------------------------------------------------

create or replace view public.vocabulary_cards with (security_invoker = true) as
select
  v.id,
  v.user_id,
  v.word,
  v.word_key,
  -- The shown meaning, definition and example: the first sense that is not archived.
  (select s.meaning    from public.vocabulary_senses s
     where s.vocabulary_id = v.id and s.user_id = v.user_id and s.archived_at is null
     order by s.position limit 1) as meaning,
  (select s.definition from public.vocabulary_senses s
     where s.vocabulary_id = v.id and s.user_id = v.user_id and s.archived_at is null
     order by s.position limit 1) as definition,
  (select s.example    from public.vocabulary_senses s
     where s.vocabulary_id = v.id and s.user_id = v.user_id and s.archived_at is null
     order by s.position limit 1) as example,
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
  v.root_id,
  v.senses_version,
  -- Every sense, archived ones included, so a restored sense can be found again.
  coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', s.id,
               'position', s.position,
               'meaning', s.meaning,
               'definition', s.definition,
               'example', s.example,
               'archived', s.archived_at is not null,
               'version', s.version
             )
             order by s.position
           )
      from public.vocabulary_senses s
     where s.vocabulary_id = v.id and s.user_id = v.user_id
  ), '[]'::jsonb) as senses
from public.vocabulary v
join public.card_states c on c.vocabulary_id = v.id and c.user_id = v.user_id;

grant select on public.vocabulary_cards to authenticated;

-- ---------------------------------------------------------------------------
-- create_vocabulary: insert primary sense when content provided
-- ---------------------------------------------------------------------------

create or replace function public.create_vocabulary(
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

  -- Create primary sense if any content provided
  if p_meaning is not null or p_definition is not null or p_example is not null then
    insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example)
    values (v_user, v_id, 0, p_meaning, p_definition, p_example);
  end if;

  return query select v_id, true;
exception
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

-- ---------------------------------------------------------------------------
-- update_vocabulary: legacy field edits, with the shown text kept in step
-- with the first live sense. Senses themselves are changed only through the
-- operation endpoints (add / update / reorder / archive / restore), each of
-- which carries its own optimistic-lock version.
-- ---------------------------------------------------------------------------

create or replace function public.update_vocabulary(p_id uuid, p_patch jsonb) returns boolean
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
    if v_key not in ('word','word_key','meaning','definition','example','date_added',
                     'mastery','review_date','root_id','expectSensesVersion') then
      raise exception 'unknown field: %', v_key using errcode = '22023';
    end if;
  end loop;

  -- A root may only be a word of this same account (and not this word itself;
  -- that stays the check constraint's job).
  if p_patch ? 'root_id' and p_patch ->> 'root_id' is not null then
    if not exists (select 1 from public.vocabulary v
                    where v.id = (p_patch ->> 'root_id')::uuid and v.user_id = v_user) then
      raise exception 'root word not found' using errcode = 'P0002';
    end if;
  end if;

  -- A caller that states which senses version it last saw is refused if the
  -- senses have moved on since. Checked before anything is written.
  if p_patch ? 'expectSensesVersion' then
    if (p_patch ->> 'expectSensesVersion')::int <>
       (select senses_version from public.vocabulary where id = p_id and user_id = v_user) then
      raise exception 'stale sense version' using errcode = 'P0003';
    end if;
  end if;

  -- ===== LEGACY CONTENT PATH =====
  if p_patch ?| array['word','word_key','meaning','definition','example','date_added','root_id'] then
    update public.vocabulary v set
      word = case when p_patch ? 'word' then p_patch ->> 'word' else v.word end,
      word_key = case when p_patch ? 'word_key' then p_patch ->> 'word_key' else v.word_key end,
      meaning = case when p_patch ? 'meaning' then p_patch ->> 'meaning' else v.meaning end,
      definition = case when p_patch ? 'definition' then p_patch ->> 'definition' else v.definition end,
      example = case when p_patch ? 'example' then p_patch ->> 'example' else v.example end,
      date_added = case when p_patch ? 'date_added' then (p_patch ->> 'date_added')::date else v.date_added end,
      root_id = case when p_patch ? 'root_id' then (p_patch ->> 'root_id')::uuid else v.root_id end
    where v.id = p_id and v.user_id = v_user and v.deleted_at is null;
    if not found then
      return false;
    end if;
    v_text_changed := true;

    -- Projection: the three shown fields live on the first sense that is not
    -- archived. A word without one gets it created here, at the first free
    -- position.
    if p_patch ?| array['meaning','definition','example'] then
      update public.vocabulary_senses s set
        meaning = case when p_patch ? 'meaning' then p_patch ->> 'meaning' else s.meaning end,
        definition = case when p_patch ? 'definition' then p_patch ->> 'definition' else s.definition end,
        example = case when p_patch ? 'example' then p_patch ->> 'example' else s.example end,
        version = s.version + 1
      where s.id = (select s2.id from public.vocabulary_senses s2
                     where s2.vocabulary_id = p_id and s2.user_id = v_user and s2.archived_at is null
                     order by s2.position limit 1);

      if not found and ((p_patch ->> 'meaning') is not null
                        or (p_patch ->> 'definition') is not null
                        or (p_patch ->> 'example') is not null) then
        insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example)
        select v_user, p_id,
               coalesce((select max(s3.position) from public.vocabulary_senses s3
                          where s3.vocabulary_id = p_id and s3.user_id = v_user), -1) + 1,
               case when p_patch ? 'meaning' then p_patch ->> 'meaning' else null end,
               case when p_patch ? 'definition' then p_patch ->> 'definition' else null end,
               case when p_patch ? 'example' then p_patch ->> 'example' else null end;
      end if;
    end if;
  end if;

  -- ===== SCHEDULE PATH (unchanged) =====
  if p_patch ?| array['mastery','review_date'] then
    update public.card_states c set
      mastery = case when p_patch ? 'mastery' then (p_patch ->> 'mastery')::smallint else c.mastery end,
      review_date = case when p_patch ? 'review_date' then (p_patch ->> 'review_date')::date else c.review_date end
    where c.vocabulary_id = p_id and c.user_id = v_user
      and exists (select 1 from public.vocabulary v where v.id = p_id and v.user_id = v_user and v.deleted_at is null);
    if not found then
      if v_text_changed then
        raise exception 'scheduling state is missing for this word' using errcode = 'P0002';
      end if;
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function public.create_vocabulary(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz) from anon, authenticated, public;
revoke all on function public.update_vocabulary(uuid, jsonb) from anon, authenticated, public;
grant execute on function public.create_vocabulary(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz) to authenticated;
grant execute on function public.update_vocabulary(uuid, jsonb) to authenticated;