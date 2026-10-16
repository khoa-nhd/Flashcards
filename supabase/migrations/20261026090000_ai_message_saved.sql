-- Schema version 12: marks a message whose analysis was added to the vocabulary.
--
-- The chat keeps a small link on the assistant message itself, so the "Added"
-- state survives a reload. Only the message's own metadata changes; the update
-- grant is narrowed by Row Level Security to the caller's own rows.

-- ---------------------------------------------------------------------------
-- Schema version marker
-- ---------------------------------------------------------------------------

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 12 $$;

revoke all on function public.app_schema_version() from anon, authenticated, public;
grant execute on function public.app_schema_version() to authenticated;

-- ---------------------------------------------------------------------------
-- Updating a message's metadata
-- ---------------------------------------------------------------------------

create policy ai_messages_update on public.ai_messages for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke update on public.ai_messages from anon, public;
grant update on public.ai_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Functions for server-side use (security invoker = runs as caller)
-- ---------------------------------------------------------------------------

-- Merges { vocabularyId, savedAt } into one assistant message's metadata.
-- The message must be the caller's own, inside the named conversation, and the
-- word must be the caller's too, so a message can only ever point at their own
-- record. Returns false when there is no such message.
create function public.mark_ai_message_saved(
  p_conversation_id uuid,
  p_message_id uuid,
  p_vocabulary_id uuid
)
returns boolean
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
  if not exists (
    select 1 from public.vocabulary v
    where v.id = p_vocabulary_id and v.user_id = v_user
  ) then
    raise exception 'vocabulary not found' using errcode = '42501';
  end if;
  update public.ai_messages m
  set metadata = m.metadata || jsonb_build_object('vocabularyId', p_vocabulary_id, 'savedAt', now())
  where m.id = p_message_id
    and m.conversation_id = p_conversation_id
    and m.user_id = v_user
    and m.role = 'assistant';
  return found;
end;
$$;

revoke all on function public.mark_ai_message_saved(uuid, uuid, uuid) from anon, authenticated, public;
grant execute on function public.mark_ai_message_saved(uuid, uuid, uuid) to authenticated;
