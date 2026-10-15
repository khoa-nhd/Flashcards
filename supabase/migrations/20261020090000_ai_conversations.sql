-- Schema version 10: AI conversations and messages.
--
-- Persistent chat history for General AI Chat and Vocabulary Expert.
-- Ownership enforced by RLS; every row belongs to exactly one user.

-- ---------------------------------------------------------------------------
-- Schema version marker
-- ---------------------------------------------------------------------------

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 10 $$;

revoke all on function public.app_schema_version() from anon, authenticated, public;
grant execute on function public.app_schema_version() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Conversations: one per user per mode. Title is editable; mode is fixed at creation.
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('general', 'vocabulary_expert')),
  title text not null default 'New conversation' check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_conversations_id_user_key unique (id, user_id)
);

create index ai_conversations_user_time_idx on public.ai_conversations (user_id, updated_at desc);

alter table public.ai_conversations enable row level security;

create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (user_id = (select auth.uid()));
create policy ai_conversations_insert on public.ai_conversations for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_conversations_update on public.ai_conversations for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ai_conversations_delete on public.ai_conversations for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.ai_conversations from anon, authenticated, public;
grant select, insert, update, delete on public.ai_conversations to authenticated;

-- Messages: append-only stream within a conversation. Role is user/assistant/system.
-- Metadata stores provider usage, model, finish_reason for assistant messages.
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (char_length(content) between 1 and 32000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_messages_conversation_fkey foreign key (conversation_id, user_id)
    references public.ai_conversations (id, user_id) on delete cascade
);

create index ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);

alter table public.ai_messages enable row level security;

create policy ai_messages_select on public.ai_messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy ai_messages_insert on public.ai_messages for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on public.ai_messages from anon, authenticated, public;
grant select, insert on public.ai_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Rate limiting: per-user sliding window using a dedicated table
-- ---------------------------------------------------------------------------

-- Tracks request timestamps for sliding-window rate limiting.
-- One row per request; pruned by a scheduled job or on read.
create table public.ai_rate_limits (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('general', 'vocabulary_expert')),
  window_start timestamptz not null,  -- bucket start (minute for per-minute, day for per-day)
  count integer not null default 1 check (count >= 1),
  primary key (user_id, mode, window_start)
);

alter table public.ai_rate_limits enable row level security;

create policy ai_rate_limits_select on public.ai_rate_limits for select to authenticated
  using (user_id = (select auth.uid()));
create policy ai_rate_limits_insert on public.ai_rate_limits for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_rate_limits_update on public.ai_rate_limits for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.ai_rate_limits from anon, authenticated, public;
grant select, insert, update on public.ai_rate_limits to authenticated;

-- ---------------------------------------------------------------------------
-- Updated_at trigger
-- ---------------------------------------------------------------------------

create trigger ai_conversations_touch before update on public.ai_conversations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Functions for server-side use (security invoker = runs as caller)
-- ---------------------------------------------------------------------------

-- Lists the caller's conversations, most recently updated first.
create function public.list_ai_conversations(p_limit integer default 50, p_offset integer default 0)
returns table (
  id uuid,
  mode text,
  title text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select id, mode, title, created_at, updated_at
  from public.ai_conversations
  where user_id = (select auth.uid())
  order by updated_at desc, id desc
  limit p_limit offset p_offset;
$$;

revoke all on function public.list_ai_conversations(integer, integer) from anon, authenticated, public;
grant execute on function public.list_ai_conversations(integer, integer) to authenticated;

-- Creates a new conversation for the caller.
create function public.create_ai_conversation(p_mode text, p_title text default 'New conversation')
returns table (id uuid, mode text, title text, created_at timestamptz, updated_at timestamptz)
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
  if p_mode not in ('general', 'vocabulary_expert') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  return query
  insert into public.ai_conversations as c (user_id, mode, title)
  values (v_user, p_mode, p_title)
  returning c.id, c.mode, c.title, c.created_at, c.updated_at;
end;
$$;

revoke all on function public.create_ai_conversation(text, text) from anon, authenticated, public;
grant execute on function public.create_ai_conversation(text, text) to authenticated;

-- Gets one conversation by id, only if it belongs to the caller.
create function public.get_ai_conversation(p_id uuid)
returns table (
  id uuid,
  mode text,
  title text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select id, mode, title, created_at, updated_at
  from public.ai_conversations
  where id = p_id and user_id = (select auth.uid());
$$;

revoke all on function public.get_ai_conversation(uuid) from anon, authenticated, public;
grant execute on function public.get_ai_conversation(uuid) to authenticated;

-- Updates the title of a conversation owned by the caller.
create function public.update_ai_conversation_title(p_id uuid, p_title text)
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
  update public.ai_conversations
  set title = p_title
  where id = p_id and user_id = v_user;
  return found;
end;
$$;

revoke all on function public.update_ai_conversation_title(uuid, text) from anon, authenticated, public;
grant execute on function public.update_ai_conversation_title(uuid, text) to authenticated;

-- Deletes a conversation and its messages (cascade via FK).
create function public.delete_ai_conversation(p_id uuid)
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
  delete from public.ai_conversations where id = p_id and user_id = v_user;
  return found;
end;
$$;

revoke all on function public.delete_ai_conversation(uuid) from anon, authenticated, public;
grant execute on function public.delete_ai_conversation(uuid) to authenticated;

-- Lists messages for a conversation owned by the caller, oldest first.
create function public.list_ai_messages(p_conversation_id uuid, p_limit integer default 200, p_offset integer default 0)
returns table (
  id uuid,
  role text,
  content text,
  metadata jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.role, m.content, m.metadata, m.created_at
  from public.ai_messages m
  join public.ai_conversations c on c.id = m.conversation_id and c.user_id = m.user_id
  where m.conversation_id = p_conversation_id and m.user_id = (select auth.uid())
  order by m.created_at asc, m.id asc
  limit p_limit offset p_offset;
$$;

revoke all on function public.list_ai_messages(uuid, integer, integer) from anon, authenticated, public;
grant execute on function public.list_ai_messages(uuid, integer, integer) to authenticated;

-- Appends a message to a conversation owned by the caller.
-- Returns the created message row.
create function public.insert_ai_message(
  p_conversation_id uuid,
  p_role text,
  p_content text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  role text,
  content text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_mode text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_role not in ('user', 'assistant', 'system') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  -- Verify the conversation belongs to the caller and get its mode.
  select c.mode into v_mode from public.ai_conversations c
  where c.id = p_conversation_id and c.user_id = v_user;
  if not found then
    raise exception 'conversation not found' using errcode = '42501';
  end if;
  return query
  insert into public.ai_messages as m (user_id, conversation_id, role, content, metadata)
  values (v_user, p_conversation_id, p_role, p_content, p_metadata)
  returning m.id, m.role, m.content, m.metadata, m.created_at;
end;
$$;

revoke all on function public.insert_ai_message(uuid, text, text, jsonb) from anon, authenticated, public;
grant execute on function public.insert_ai_message(uuid, text, text, jsonb) to authenticated;

-- Checks and increments rate limit counters for the caller.
-- Returns (allowed boolean, retry_after_seconds integer, current_count integer, limit integer).
-- p_window: 'minute' or 'day'
create function public.check_ai_rate_limit(
  p_mode text,
  p_window text,
  p_limit integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  current_count integer,
  "limit" integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_window_start timestamptz;
  v_now timestamptz := now();
  v_count integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_mode not in ('general', 'vocabulary_expert') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if p_window = 'minute' then
    v_window_start := date_trunc('minute', v_now);
  elsif p_window = 'day' then
    v_window_start := date_trunc('day', v_now);
  else
    raise exception 'invalid window' using errcode = '22023';
  end if;

  -- Upsert the counter for this window.
  insert into public.ai_rate_limits (user_id, mode, window_start, count)
  values (v_user, p_mode, v_window_start, 1)
  on conflict (user_id, mode, window_start) do update set count = ai_rate_limits.count + 1
  returning count into v_count;

  if v_count > p_limit then
    -- Over limit: calculate seconds until window resets.
    declare v_retry integer;
    begin
      if p_window = 'minute' then
        v_retry := 60 - extract(second from v_now)::integer;
      else
        v_retry := 86400 - extract(epoch from (v_now - v_window_start))::integer;
      end if;
      return query select false, v_retry, v_count, p_limit;
    end;
  else
    return query select true, 0, v_count, p_limit;
  end if;
end;
$$;

revoke all on function public.check_ai_rate_limit(text, text, integer) from anon, authenticated, public;
grant execute on function public.check_ai_rate_limit(text, text, integer) to authenticated;

-- Prunes old rate limit rows (older than 2 days). Can be called by a cron job.
create function public.prune_ai_rate_limits()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.ai_rate_limits
  where window_start < now() - interval '2 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_ai_rate_limits() from anon, authenticated, public;
grant execute on function public.prune_ai_rate_limits() to authenticated;