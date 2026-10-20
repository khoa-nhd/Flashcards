-- Schema version 15: a trashed word is changed only by the call meant to
-- reach it.
--
-- Version 14 claimed the word in `add_vocabulary_sense` and
-- `restore_vocabulary_sense` whatever state it was in, so that an import
-- interrupted after its word landed could finish its senses even if the word
-- had been moved to the trash in the meantime. That also meant the ordinary
-- sense calls would write into a word the owner had thrown away: the two
-- callers were never told apart.
--
-- This file separates them:
--
--   * `add_vocabulary_sense` and `restore_vocabulary_sense` now refuse a word
--     in the trash, answering P0002 — the same as a word that is not there.
--     Together with the checks version 13 and 14 already carry, every sense
--     mutation — add, update, archive, restore, reorder, and the legacy
--     whole-word edit — is now refused inside the database for a trashed
--     word, not only in the service that calls it.
--   * `update_vocabulary_sense` and `archive_vocabulary_sense` take over the
--     two edits that until now ran as bare table updates. Same versions
--     checked, same answers given, but the word is claimed first and must be
--     live: the lock order is the word then the sense on every path that
--     changes senses, and no caller can edit a trashed word's senses through
--     them either.
--   * `resume_vocabulary_sense` is the one call allowed to finish an import
--     on a trashed word. It is narrow on purpose: it claims the word for its
--     owner whatever state it is in, and from there it can do only two
--     things — add the sense whose request id has not landed yet, and set
--     the archive flag the file carries on the sense that request id already
--     owns. It never rewrites content, never touches the word row, and never
--     reaches another account's rows. The import's completion step is its
--     only caller.
--
-- Additive: three new functions and tighter bodies for two existing ones; no
-- column, table or signature changes. Run this file once, after the version
-- 14 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 15 $$;

-- ---------------------------------------------------------------------------
-- add_vocabulary_sense: appended under the word's claim, when the word is
-- live
-- ---------------------------------------------------------------------------
--
-- Same signature as version 14's. The claim now requires the word to be
-- live; finishing an interrupted import of a trashed word goes through
-- resume_vocabulary_sense below.

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
  -- instead of racing it. A word in the trash is not claimed: the ordinary
  -- add does not write into a word the owner has thrown away, and the
  -- import that has to finish one uses resume_vocabulary_sense.
  perform 1 from public.vocabulary v
   where v.id = p_vocabulary_id and v.user_id = v_user and v.deleted_at is null
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
--
-- Same signature as version 14's. The word claim now requires it to be live.

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
  -- A word in the trash is not claimed: restoring a sense is an ordinary
  -- sense operation and does not write into a word the owner has thrown
  -- away.
  perform 1 from public.vocabulary v
   where v.id = v_word and v.user_id = v_user and v.deleted_at is null
     for update;
  if not found then
    raise exception 'word not found' using errcode = 'P0002';
  end if;

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
-- update_vocabulary_sense: one statement, under the word's claim
-- ---------------------------------------------------------------------------
--
-- The edit that until this file ran as a bare table update from the
-- application. The versions checked and the answers given are the ones that
-- update always gave: a sense that is not there (or not this account's) is
-- P0002, a version that has moved on — or a sense that has been archived,
-- which is not edited — is P0003. The word is claimed first and must be
-- live, so a trashed word's senses cannot be edited through this call.

create or replace function public.update_vocabulary_sense(
  p_sense_id uuid,
  p_expected_version integer,
  p_changes jsonb
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_word uuid;
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

  -- Claim the word, which must be live. This is the lock order every sense
  -- change now takes: the word first, then the sense.
  perform 1 from public.vocabulary v
   where v.id = v_word and v.user_id = v_user and v.deleted_at is null
     for update;
  if not found then
    raise exception 'word not found' using errcode = 'P0002';
  end if;

  -- A field absent from p_changes is left as it is; a field present with a
  -- null value is cleared. The version sits in the same statement: a second
  -- change in between matches no row, and nothing is overwritten.
  update public.vocabulary_senses s
     set meaning = case when p_changes ? 'meaning' then p_changes ->> 'meaning' else s.meaning end,
         definition = case when p_changes ? 'definition' then p_changes ->> 'definition' else s.definition end,
         example = case when p_changes ? 'example' then p_changes ->> 'example' else s.example end,
         version = s.version + 1
   where s.id = p_sense_id and s.user_id = v_user
     and s.version = p_expected_version and s.archived_at is null;
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
-- archive_vocabulary_sense: the flag, under the word's claim
-- ---------------------------------------------------------------------------
--
-- The archive that until this file ran as a bare table update. An archived
-- sense keeps its identity, its content and its position; only the flag and
-- the version move.

create or replace function public.archive_vocabulary_sense(
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

  perform 1 from public.vocabulary v
   where v.id = v_word and v.user_id = v_user and v.deleted_at is null
     for update;
  if not found then
    raise exception 'word not found' using errcode = 'P0002';
  end if;

  update public.vocabulary_senses s
     set archived_at = now(), version = s.version + 1
   where s.id = p_sense_id and s.user_id = v_user
     and s.version = p_expected_version and s.archived_at is null;
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
-- resume_vocabulary_sense: finishing an interrupted import, trashed word or
-- not
-- ---------------------------------------------------------------------------
--
-- The import path's completion call, and the only caller allowed to write
-- senses on a word in the trash. One call per row of the file, under the
-- word's claim:
--
--   * whose request id has landed already answers with that sense — after
--     setting the archive flag the file carries, if it is not set and the
--     file asks for it. Nothing else about an existing sense changes: an
--     edit the owner made after the first run survives the rest of the
--     import, and a sense archived once is never brought back by a retry;
--   * whose request id has not landed adds the sense at the end, with the
--     archive flag in the same statement when the file carries one, so a
--     sense is never stored without the state its row named.
--
-- A repeat of the same batch therefore lands on the same senses instead of
-- doubling them, and a run that stopped between the word and its senses
-- finishes rather than starting over.

create or replace function public.resume_vocabulary_sense(
  p_vocabulary_id uuid,
  p_meaning text,
  p_definition text,
  p_example text,
  p_request_id uuid,
  p_archived boolean default false
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

  -- The one claim that reaches into the trash. Ownership is the same as
  -- everywhere else — another account's word answers P0002 — and what this
  -- call may do with the word once it holds it is exactly the two things
  -- below.
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
    if p_archived then
      update public.vocabulary_senses s
         set archived_at = now(), version = s.version + 1
       where s.id = v_id and s.archived_at is null;
    end if;
    id := v_id;
    created := false;
    return next;
    return;
  end if;

  select coalesce(max(s.position), -1) + 1 into v_position
    from public.vocabulary_senses s
   where s.vocabulary_id = p_vocabulary_id and s.user_id = v_user;

  insert into public.vocabulary_senses (user_id, vocabulary_id, position, meaning, definition, example, request_id, archived_at)
  values (v_user, p_vocabulary_id, v_position, p_meaning, p_definition, p_example, p_request_id,
          case when p_archived then now() else null end)
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
-- Privileges: execute for the signed-in user only, as with versions 13 and
-- 14's
-- ---------------------------------------------------------------------------

revoke all on function public.update_vocabulary_sense(uuid, integer, jsonb) from anon, authenticated, public;
revoke all on function public.archive_vocabulary_sense(uuid, integer) from anon, authenticated, public;
revoke all on function public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean) from anon, authenticated, public;
grant execute on function public.update_vocabulary_sense(uuid, integer, jsonb) to authenticated;
grant execute on function public.archive_vocabulary_sense(uuid, integer) to authenticated;
grant execute on function public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean) to authenticated;
