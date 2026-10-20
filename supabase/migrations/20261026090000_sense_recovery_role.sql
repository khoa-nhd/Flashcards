-- Schema version 17: the recovery exception belongs to a role, not a setting.
--
-- Version 16 let resume_vocabulary_sense reach into a trashed word by raising
-- a custom setting (app.sense_recovery) that its restrictive policies
-- trusted, with the claim that "a table write cannot carry that setting".
-- FC-SEC-013 G1 disproved that on schema 16 against real PostgreSQL: any
-- session running SQL as `authenticated` can raise the setting itself —
-- select set_config('app.sense_recovery','on',true) or
-- `set local app.sense_recovery = 'on'` — and then insert into or update the
-- senses of its own trashed word directly, without any call. Both spellings
-- were measured; both writes landed. A setting is caller-controlled by
-- design; it cannot carry authority.
--
-- Authority now sits where PostgreSQL keeps it: in roles. A dedicated
-- NOLOGIN role granted to nobody is the only current_user the exception in
-- the guards recognises, and the only way to become that role is to execute
-- a function it owns — resume_vocabulary_sense, now SECURITY DEFINER with
-- search_path pinned. No statement a session can run changes its
-- current_user; `set role` to the recovery role fails for want of
-- membership, and the migration grants that membership to nobody.
--
-- Audit of the definer (FC-SEC-013 G2 requires this to be written down):
--   owner      app_sense_recovery — nologin, without superuser, createrole,
--              createdb, replication or bypassrls attributes, a member of
--              no role, and the owner of no table, so row level security
--              still applies to everything the function's statements do.
--   search_path pinned to '' ; the body names only pg_catalog objects and
--              schema-qualified ones (auth.uid, public.*).
--   grants     execute on the function: authenticated only (revoke all from
--              anon, authenticated, public first). What the body itself
--              needs: usage on schemas public and auth, execute on
--              auth.uid(), select+update on vocabulary (the claim and the
--              projection trigger), select+insert+update on
--              vocabulary_senses — delete on neither, matching version 13.
--   rls        the role carries its own permissive policies mirroring
--              version 13's conditions, so it sees only the rows of the
--              account whose claims the request carries, and both
--              restrictive guards apply to it as well: even inside the
--              call, the word must still belong to that account.
--
-- What does not change: authenticated's direct-table privileges (select,
-- insert, update; delete withheld), the live-word direct write path,
-- request idempotency, ownership checks, archived senses, every call's
-- signature and answers, and legacy application compatibility. The setting
-- app.sense_recovery is no longer read by anything.

create or replace function public.app_schema_version() returns integer
language sql
stable
as $$
  select 17::integer
$$;

-- ---------------------------------------------------------------------------
-- The role: the only current_user the trash exception will recognise.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_sense_recovery') then
    execute 'create role app_sense_recovery';
  end if;
end $$;

alter role app_sense_recovery
  nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- What executing the call needs: the schemas its body names, the account
-- lookup it performs, and the two tables its statements and their triggers
-- touch — select and update on the word (the claim, the projection sync and
-- the version bump), select, insert and update on the senses, delete on
-- neither.
grant usage on schema public to app_sense_recovery;
grant usage on schema auth to app_sense_recovery;
grant execute on function auth.uid() to app_sense_recovery;
grant select, update on public.vocabulary to app_sense_recovery;
grant select, insert, update on public.vocabulary_senses to app_sense_recovery;

-- ---------------------------------------------------------------------------
-- Permissive policies for the role, mirroring version 13's conditions for
-- the same commands: it reads and writes only rows of the account the
-- request's claims carry. No delete policy — the role never deletes.
-- ---------------------------------------------------------------------------
create policy vocabulary_recovery_select on public.vocabulary
  for select to app_sense_recovery using (user_id = (select auth.uid()));
create policy vocabulary_recovery_update on public.vocabulary
  for update to app_sense_recovery
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy vocabulary_senses_recovery_select on public.vocabulary_senses
  for select to app_sense_recovery using (user_id = (select auth.uid()));
create policy vocabulary_senses_recovery_insert on public.vocabulary_senses
  for insert to app_sense_recovery with check (user_id = (select auth.uid()));
create policy vocabulary_senses_recovery_update on public.vocabulary_senses
  for update to app_sense_recovery
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- The guards, restated: same conditions, different exception. Version 16
-- trusted a custom setting any session could raise (FC-SEC-013 G1);
-- current_user cannot be set, raised or claimed — only assumed by executing
-- a function that runs as the role. Both guards also apply to the recovery
-- role itself, so the call must still name a word owned by the account.
-- ---------------------------------------------------------------------------
drop policy if exists vocabulary_senses_insert_guard on public.vocabulary_senses;
create policy vocabulary_senses_insert_guard on public.vocabulary_senses
  as restrictive
  for insert
  to authenticated, app_sense_recovery
  with check (
    exists (
      select 1 from public.vocabulary v
       where v.id = vocabulary_senses.vocabulary_id
         and v.user_id = auth.uid()
         and (v.deleted_at is null
              or current_user = 'app_sense_recovery')
    )
  );

drop policy if exists vocabulary_senses_update_guard on public.vocabulary_senses;
create policy vocabulary_senses_update_guard on public.vocabulary_senses
  as restrictive
  for update
  to authenticated, app_sense_recovery
  using (
    exists (
      select 1 from public.vocabulary v
       where v.id = vocabulary_senses.vocabulary_id
         and v.user_id = auth.uid()
         and (v.deleted_at is null
              or current_user = 'app_sense_recovery')
    )
  );

-- ---------------------------------------------------------------------------
-- The one function that may become the role. Body unchanged from version
-- 16 except that it no longer raises the setting — its authority is its
-- owner. Every check it made it still makes: signed in, the word is the
-- account's, the request id is the row's, positions continue past the end,
-- and a repeat submission names the sense that landed.
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
security definer
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
  -- below. The exception itself comes from the function's owner: this body
  -- runs as app_sense_recovery, the role the guards name, and no caller can
  -- arrive there any other way.
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

alter function public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean)
  owner to app_sense_recovery;

revoke all on function public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean) from anon, authenticated, public;
grant execute on function public.resume_vocabulary_sense(uuid, text, text, text, uuid, boolean) to authenticated;
