-- Schema version 16: the rule about a word and its senses belongs to the
-- table, so it holds whichever path arrives.
--
-- Versions 13 to 15 hold that rule in the calls: they claim the word, refuse
-- one in the trash, and the import's completion call is the only one allowed
-- to reach a trashed word. Those protections cover the calls. The table
-- itself still answered to a direct write — version 13's policies ask only
-- whose row it is — so an account could edit or extend the senses of its own
-- trashed word by writing the table, where no call would have let it.
--
-- This file closes that with two restrictive policies. They add conditions
-- and take nothing away: a row is still only reachable under version 13's
-- permissive policies, and now the word behind it must belong to the account
-- making the statement and be out of the trash. The one authorised exception
-- is resume_vocabulary_sense, which announces itself with a transaction-
-- scoped setting that a table write cannot carry, so the exception travels
-- with that call and nowhere else.
--
-- Measured before this file, on schema 15 against real PostgreSQL
-- (FC-RELEASE-012 report section D): a direct content edit and a direct
-- insert on the account's own trashed word both succeeded; a direct delete,
-- a cross-account insert and a cross-account edit were already refused — by
-- the absent delete policy, the foreign key checked through the row-level
-- policies, and the permissive policy. This file makes the whole rule
-- explicit rather than partly incidental.

create or replace function public.app_schema_version() returns integer
language sql
stable
as $$
  select 16::integer
$$;

-- ---------------------------------------------------------------------------
-- The guard: the word behind the row belongs to the account and is live — or
-- the statement belongs to the completion call, which said so with the
-- setting. Restrictive policies only add: every statement must satisfy at
-- least one permissive policy (version 13's, unchanged) and every restrictive
-- one, so this tightens nothing that was properly open.
-- ---------------------------------------------------------------------------

create policy vocabulary_senses_insert_guard on public.vocabulary_senses
  as restrictive
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.vocabulary v
       where v.id = vocabulary_senses.vocabulary_id
         and v.user_id = auth.uid()
         and (v.deleted_at is null
              or current_setting('app.sense_recovery', true) = 'on')
    )
  );

create policy vocabulary_senses_update_guard on public.vocabulary_senses
  as restrictive
  for update
  to authenticated
  using (
    exists (
      select 1 from public.vocabulary v
       where v.id = vocabulary_senses.vocabulary_id
         and v.user_id = auth.uid()
         and (v.deleted_at is null
              or current_setting('app.sense_recovery', true) = 'on')
    )
  );

-- ---------------------------------------------------------------------------
-- The completion call announces itself: a setting that lives to the end of
-- the transaction and is named here and nowhere else. Everything the call may
-- do — the word is the account's, the sense carries the call's own request
-- id — is still the call's own claim, checked below exactly as version 15
-- checked it; the setting lifts only the table's trash condition, for the
-- statements this one call is made of.
-- ---------------------------------------------------------------------------

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

  perform set_config('app.sense_recovery', 'on', true);

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
