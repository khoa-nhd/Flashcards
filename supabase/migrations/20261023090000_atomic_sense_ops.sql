-- Schema version 14: sense operations that are atomic in the database.
--
-- Version 13 gave every word its senses. The operations that change them
-- still ran as sequences of statements sent by the application: a version
-- check first, then one UPDATE per sense. On a hosted database each of those
-- is its own request and its own transaction, so a failure part-way left the
-- order half-moved, and two server instances could interleave their
-- sequences. This file moves the three operations whose correctness depends
-- on the sequence into the database, where one statement is one transaction:
--
--   * reorder_vocabulary_senses claims the word's row, checks the senses
--     version the client last saw, checks that the order sent names every
--     live sense exactly once, and only then moves the rows. Everything
--     succeeds or nothing does. A sense added or restored while the request
--     was in the air changes the version and the set, and the reorder is
--     refused with a conflict instead of being arranged around the
--     newcomer.
--   * add_vocabulary_sense claims the word's row before choosing the next
--     position, so two adds — or an add and a reorder — from two instances
--     cannot claim one position or write around each other.
--   * restore_vocabulary_sense claims the word's row before placing the
--     sense at the end, for the same reason.
--
-- create_vocabulary_with_senses writes a word and all of its senses in one
-- call, so an imported row cannot be left behind as a word whose senses are
-- still missing.
--
-- vocabulary_senses_sync_content keeps the legacy meaning, definition and
-- example columns on the word in step with the first live sense: senses are
-- the content, those columns are its projection, and every read path — the
-- vocabulary_cards view and the base table alike — answers the same from
-- now on. A one-off reconciliation brings rows written before this file into
-- line.
--
-- Additive: new functions, one trigger, no column or table changes; run this
-- file once, after the version 13 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 14 $$;

-- ---------------------------------------------------------------------------
-- create_vocabulary_with_senses: a word and its senses in one transaction
-- ---------------------------------------------------------------------------
--
-- The import path's row: everything the row names lands together, or none of
-- it does. When senses come with the row they are the content — the row's own
-- meaning, definition and example are not stored a second time. A repeat of
-- the request id answers with the word that already exists and does not touch
-- its senses; finishing a run that stopped part-way is fill's job, not this
-- function's.

create or replace function public.create_vocabulary_with_senses(
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
  p_created_at timestamptz default null,
  p_senses jsonb default null
) returns table (id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_created boolean;
  v_count integer;
begin
  v_count := case when p_senses is not null and jsonb_typeof(p_senses) = 'array'
                  then jsonb_array_length(p_senses)
                  else 0
             end;

  select c.id, c.created into v_id, v_created
    from public.create_vocabulary(
      p_word => p_word,
      p_word_key => p_word_key,
      p_mastery => p_mastery,
      p_meaning => case when v_count > 0 then null else p_meaning end,
      p_definition => case when v_count > 0 then null else p_definition end,
      p_example => case when v_count > 0 then null else p_example end,
      p_date_added => p_date_added,
      p_review_date => p_review_date,
      p_request_id => p_request_id,
      p_external_source => p_external_source,
      p_external_id => p_external_id,
      p_created_at => p_created_at) as c;

  -- Only a word this call made gets its senses here. A word that already
  -- exists answers as a repeated submission, and the caller finishes what is
  -- missing by sending the row again.
  if v_created and v_count > 0 then
    insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example, request_id)
    select auth.uid(), v_id,
           (row_number() over ()) - 1,
           (sense ->> 'meaning')::text,
           (sense ->> 'definition')::text,
           (sense ->> 'example')::text,
           (sense ->> 'request_id')::uuid
      from jsonb_array_elements(p_senses) as sense;
  end if;

  id := v_id;
  created := v_created;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_vocabulary_sense: append under the word's claim
-- ---------------------------------------------------------------------------

create or replace function public.add_vocabulary_sense(
  p_vocabulary_id uuid,
  p_meaning text,
  p_definition text,
  p_example text,
  p_request_id uuid
) returns table (id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_position smallint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Claim the word before choosing a position: an add or a reorder from
  -- another instance waits here and then reads the state this one left,
  -- instead of racing it. A word in the trash is claimed too — completing an
  -- interrupted import of a trashed word must not leave its senses behind.
  perform 1 from public.vocabulary v
   where v.id = p_vocabulary_id and v.user_id = v_user
     for update;
  if not found then
    raise exception 'word not found' using errcode = 'P0002';
  end if;

  select s.id into v_id
    from public.vocabulary_senses s
   where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user
     and s.request_id = p_request_id;
  if found then
    id := v_id;
    created := false;
    return next;
    return;
  end if;

  select coalesce(max(s.position), -1) + 1 into v_position
    from public.vocabulary_senses s
   where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user;

  insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example, request_id)
  values (v_user, p_vocabulary_id, v_position, p_meaning, p_definition, p_example, p_request_id)
  returning vocabulary_senses.id into v_id;

  id := v_id;
  created := true;
  return next;
exception
  when unique_violation then
    -- The same request id, sent twice, raced to here. Whichever attempt
    -- landed first owns the sense; this one names it.
    select s.id into v_id
      from public.vocabulary_senses s
     where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user
       and s.request_id = p_request_id;
    if not found then
      raise;
    end if;
    id := v_id;
    created := false;
    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- restore_vocabulary_sense: back at the end of the order, under the claim
-- ---------------------------------------------------------------------------

create or replace function public.restore_vocabulary_sense(
  p_sense_id uuid,
  p_expected_version integer
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_word uuid;
  v_position smallint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select s.vocabulary_id into v_word
    from public.vocabulary_senses s
   where s.id = p_sense_id and s.user_id = v_user;
  if not found then
    raise exception 'sense not found' using errcode = 'P0002';
  end if;

  -- Claim the word before placing the sense: a reorder in flight finishes
  -- first, and the end of the order is computed from what it left behind.
  perform 1 from public.vocabulary v
   where v.id = v_word and v.user_id = v_user
     for update;

  select coalesce(max(s.position), -1) + 1 into v_position
    from public.vocabulary_senses s
   where s.vocabulary_id = v_word and s.user_id = v_user;

  update public.vocabulary_senses s
     set archived_at = null, position = v_position, version = s.version + 1
   where s.id = p_sense_id and s.user_id = v_user
     and s.version = p_expected_version and s.archived_at is not null;
  if not found then
    if not exists (select 1 from public.vocabulary_senses s
                    where s.id = p_sense_id and s.user_id = v_user) then
      raise exception 'sense not found' using errcode = 'P0002';
    end if;
    raise exception 'stale sense version' using errcode = 'P0003';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- reorder_vocabulary_senses: one statement, or none of it
-- ---------------------------------------------------------------------------

create or replace function public.reorder_vocabulary_senses(
  p_vocabulary_id uuid,
  p_sense_ids jsonb,
  p_expected_version integer
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_version integer;
  v_live uuid[];
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Claim the word. Every sense change bumps senses_version under this same
  -- row lock, so anything that lands while this request waits is seen by the
  -- version check instead of slipping past it.
  select v.senses_version into v_version
    from public.vocabulary v
   where v.id = p_vocabulary_id and v.user_id = v_user and v.deleted_at is null
     for update;
  if not found then
    raise exception 'word not found' using errcode = 'P0002';
  end if;
  if v_version is distinct from p_expected_version then
    raise exception 'stale sense version' using errcode = 'P0003';
  end if;

  select coalesce(array_agg(s.id), '{}') into v_live
    from public.vocabulary_senses s
   where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user
     and s.archived_at is null;

  -- The order sent has to name every live sense of this word exactly once:
  -- no repeats, nothing of another word, nothing missing. A sense added or
  -- restored while the request was in the air fails one of these checks and
  -- the reorder is refused whole.
  if p_sense_ids is null
     or jsonb_typeof(p_sense_ids) <> 'array'
     or jsonb_array_length(p_sense_ids) <> coalesce(array_length(v_live, 1), 0)
     or jsonb_array_length(p_sense_ids) <>
        (select count(distinct element) from jsonb_array_elements(p_sense_ids) as t(element))
     or exists (select 1 from jsonb_array_elements(p_sense_ids) as t(element)
                 where jsonb_typeof(t.element) = 'null')
     or exists (select 1 from jsonb_array_elements_text(p_sense_ids) as t(id)
                 where not exists (select 1 from unnest(v_live) as v(id) where v.id = t.id::uuid)) then
    raise exception 'the order sent does not match the senses stored for this word'
      using errcode = '22023';
  end if;

  -- Positions are unique per word, so lift every sense out of the way first.
  -- These statements and the checks above run as one statement inside this
  -- transaction: a failure anywhere leaves every position as it was.
  update public.vocabulary_senses s
     set position = s.position + 1000
   where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user;

  with placed as (
    select (t.id)::uuid as id, (t.ord - 1)::smallint as position
      from jsonb_array_elements_text(p_sense_ids) with ordinality as t(id, ord)
  )
  update public.vocabulary_senses s
     set position = p.position
    from placed p
   where s.id = p.id;

  -- The archived senses keep their order and pack in behind the live ones.
  with packed as (
    select s.id,
           (jsonb_array_length(p_sense_ids)
            + row_number() over (order by s.position) - 1)::smallint as position
      from public.vocabulary_senses s
     where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user
       and s.archived_at is not null
  )
  update public.vocabulary_senses s
     set position = k.position
    from packed k
   where s.id = k.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Legacy columns follow the first live sense
-- ---------------------------------------------------------------------------
--
-- Senses are the content. The meaning, definition and example on the word
-- itself are the projection every older reader knows, and from this file on
-- they are written by the database itself whenever a sense change moves what
-- the projection should show: a new first sense, an archive, a restore, a
-- reorder, an edit of the sense's text. update_vocabulary already wrote both
-- in one statement; this closes the paths that wrote only the senses.

create or replace function public.vocabulary_senses_sync_content() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_word uuid := coalesce(new.vocabulary_id, old.vocabulary_id);
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_first record;
begin
  select s.meaning, s.definition, s.example into v_first
    from public.vocabulary_senses s
   where s.vocabulary_id = v_word and s.user_id = v_user
     and s.archived_at is null
   order by s.position
   limit 1;

  update public.vocabulary v
     set meaning = v_first.meaning,
         definition = v_first.definition,
         example = v_first.example
   where v.id = v_word and v.user_id = v_user
     and (v.meaning is distinct from v_first.meaning
       or v.definition is distinct from v_first.definition
       or v.example is distinct from v_first.example);
  return coalesce(new, old);
end;
$$;

create trigger vocabulary_senses_sync
  after insert or update or delete on public.vocabulary_senses
  for each row execute function public.vocabulary_senses_sync_content();

-- One-off reconciliation: rows written between version 13 and this file may
-- hold legacy columns the senses have moved past.

update public.vocabulary v
   set meaning = first_s.meaning,
       definition = first_s.definition,
       example = first_s.example
  from (
    select distinct on (s.vocabulary_id, s.user_id)
           s.vocabulary_id, s.user_id, s.meaning, s.definition, s.example
      from public.vocabulary_senses s
     where s.archived_at is null
     order by s.vocabulary_id, s.user_id, s.position
  ) as first_s
 where first_s.vocabulary_id = v.id
   and first_s.user_id = v.user_id
   and (v.meaning is distinct from first_s.meaning
     or v.definition is distinct from first_s.definition
     or v.example is distinct from first_s.example);

update public.vocabulary v
   set meaning = null, definition = null, example = null
 where (v.meaning is not null or v.definition is not null or v.example is not null)
   and not exists (select 1 from public.vocabulary_senses s
                    where s.vocabulary_id = v.id and s.user_id = v.user_id
                      and s.archived_at is null);

-- ---------------------------------------------------------------------------
-- Privileges: execute for the signed-in user only, as with version 13's
-- ---------------------------------------------------------------------------

revoke all on function public.create_vocabulary_with_senses(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz, jsonb) from anon, authenticated, public;
revoke all on function public.add_vocabulary_sense(uuid, text, text, text, uuid) from anon, authenticated, public;
revoke all on function public.restore_vocabulary_sense(uuid, integer) from anon, authenticated, public;
revoke all on function public.reorder_vocabulary_senses(uuid, jsonb, integer) from anon, authenticated, public;
grant execute on function public.create_vocabulary_with_senses(text, text, smallint, text, text, text, date, date, uuid, text, text, timestamptz, jsonb) to authenticated;
grant execute on function public.add_vocabulary_sense(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.restore_vocabulary_sense(uuid, integer) to authenticated;
grant execute on function public.reorder_vocabulary_senses(uuid, jsonb, integer) to authenticated;
