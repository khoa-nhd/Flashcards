-- Version 20: reminders (docs/gamification-plan.md, phase 4).
--
-- Web push. Each account keeps its own devices and choices. A timer calls the
-- server every 15 minutes with a secret; the server holds no key that can read
-- every account, so what it needs to decide who to remind comes from the
-- functions below, which only answer that secret (its SHA-256 is kept here)
-- and only give what a reminder says: no words, no answers.
--
-- Additive only, and safe to run again. Needs version 19.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 20 $$;

-- ---------------------------------------------------------------------------
-- Each account's own: devices and choices
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text primary key check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) between 1 and 200),
  auth text not null check (char_length(auth) between 1 and 100),
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.notification_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  streak boolean not null default true,
  league boolean not null default true,
  reminder boolean not null default true,
  social boolean not null default true,
  reminder_at time not null default '19:00',
  quiet_from time not null default '23:00',
  quiet_until time not null default '07:00',
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
alter table public.notification_settings enable row level security;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists notification_settings_select on public.notification_settings;
create policy notification_settings_select on public.notification_settings for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists notification_settings_insert on public.notification_settings;
create policy notification_settings_insert on public.notification_settings for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists notification_settings_update on public.notification_settings;
create policy notification_settings_update on public.notification_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.push_subscriptions, public.notification_settings from anon, authenticated, public;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant select, insert, update on public.notification_settings to authenticated;

-- A browser's push address belongs to whoever subscribed on it last: one that
-- another account had (signed in on the same browser before) moves to the
-- caller, so that account's reminders stop appearing here. Knowing the
-- address is what proves it is this browser; push services make it unguessable.
create or replace function public.push_take_device(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.push_subscriptions p where p.endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end;
$$;

revoke all on function public.push_take_device(text, text, text) from anon, authenticated, public;
grant execute on function public.push_take_device(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The timer's: what was sent, and what it remembers between runs
-- ---------------------------------------------------------------------------

-- The SHA-256 (hex) of CRON_TOKEN; the owner sets it once in the SQL Editor.
create table if not exists public.notify_secret (
  id boolean primary key default true check (id),
  hash text not null check (hash ~ '^[0-9a-f]{64}$')
);

-- One row per reminder sent: the same reminder is never sent twice on a day.
create table if not exists public.notifications_sent (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  key text not null check (char_length(key) between 1 and 80),
  sent_at timestamptz not null default now(),
  primary key (user_id, day, key)
);

-- What the timer saw last time, to notice a change: a league zone, who was ahead.
create table if not exists public.notify_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 80),
  value text not null check (char_length(value) <= 40),
  primary key (user_id, key)
);

alter table public.notify_secret enable row level security;
alter table public.notifications_sent enable row level security;
alter table public.notify_state enable row level security;
revoke all on public.notify_secret, public.notifications_sent, public.notify_state from anon, authenticated, public;

-- Whether a token is the timer's secret.
create or replace function public.notify_check(p_token text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select s.hash into v_hash from public.notify_secret s;
  if v_hash is null then
    raise exception 'the reminder secret is not set' using errcode = '55000';
  end if;
  if p_token is null or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_hash then
    raise exception 'not the reminder timer' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.notify_check(text) from anon, authenticated, public;

-- Every account with a device to remind, at the timer's moment, with what deciding needs: its own
-- clock, its choices, whether today's goals are met and yesterday's were
-- (or a freeze covered it), how many words wait, what was sent today, the
-- week's league standing it was last seen at, and its latest league result.
create or replace function public.notify_candidates(p_token text, p_now timestamptz)
returns table (
  user_id uuid,
  time_zone text,
  language text,
  local_day date,
  local_time time,
  streak boolean,
  league boolean,
  reminder boolean,
  social boolean,
  reminder_at time,
  quiet_from time,
  quiet_until time,
  met_today boolean,
  streak_alive boolean,
  due integer,
  sent text[],
  state jsonb,
  league_result jsonb,
  golden_hour boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.notify_check(p_token);
  return query
  with people as (
    select distinct p.user_id from public.push_subscriptions p
  ),
  clock as (
    select pe.user_id,
           coalesce(us.time_zone, 'UTC') as zone,
           coalesce(us.ui_language, 'vi') as lang,
           (p_now at time zone coalesce(us.time_zone, 'UTC'))::date as today,
           (p_now at time zone coalesce(us.time_zone, 'UTC'))::time as at
      from people pe
      left join public.user_settings us on us.user_id = pe.user_id
  )
  select c.user_id, c.zone, c.lang, c.today, c.at,
         coalesce(ns.streak, true), coalesce(ns.league, true), coalesce(ns.reminder, true), coalesce(ns.social, true),
         coalesce(ns.reminder_at, '19:00'::time), coalesce(ns.quiet_from, '23:00'::time), coalesce(ns.quiet_until, '07:00'::time),
         exists (select 1 from public.study_days d where d.user_id = c.user_id and d.day = c.today and d.met),
         exists (select 1 from public.study_days d where d.user_id = c.user_id and d.day = c.today - 1 and d.met)
           or exists (select 1 from public.game_freezes f where f.user_id = c.user_id and f.used_on = c.today - 1),
         (select count(*)::integer
            from public.card_states s
            join public.vocabulary v on v.id = s.vocabulary_id and v.user_id = s.user_id
           where s.user_id = c.user_id and v.deleted_at is null and s.suspended_at is null
             and (case when s.fsrs_due is not null then s.fsrs_due < ((c.today + 1)::timestamp at time zone c.zone)
                       else s.due_on is not null and s.due_on <= c.today end)),
         coalesce((select array_agg(n.key) from public.notifications_sent n where n.user_id = c.user_id and n.day = c.today), '{}'::text[]),
         coalesce((select jsonb_object_agg(st.key, st.value) from public.notify_state st where st.user_id = c.user_id), '{}'::jsonb),
         (select r.payload || jsonb_build_object('id', r.id) from public.game_rewards r
           where r.user_id = c.user_id and r.kind = 'league' and r.created_at > p_now - interval '2 days'
           order by r.created_at desc limit 1),
         coalesce((select e.enabled from public.game_events e where e.event = 'golden_hour'), true)
    from clock c
    left join public.notification_settings ns on ns.user_id = c.user_id;
end;
$$;

revoke all on function public.notify_candidates(text, timestamptz) from anon, authenticated, public;
grant execute on function public.notify_candidates(text, timestamptz) to anon, authenticated;

-- This league week's groups, with each real member's week XP: the server adds
-- the rivals and works out the zones, as the league page does.
create or replace function public.notify_league(p_token text, p_week date)
returns table (group_id uuid, tier smallint, created_at timestamptz, member_id uuid, week_xp integer, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.notify_check(p_token);
  return query
  select g.id, g.tier, g.created_at, m.user_id, public.league_week_xp(m.user_id, p_week), m.joined_at
    from public.league_groups g
    join public.league_members m on m.group_id = g.id
   where g.week_start = p_week
     and exists (select 1 from public.push_subscriptions p where p.user_id in (select m2.user_id from public.league_members m2 where m2.group_id = g.id));
end;
$$;

revoke all on function public.notify_league(text, date) from anon, authenticated, public;
grant execute on function public.notify_league(text, date) to anon, authenticated;

-- Friends (following each other) of accounts with a device, with both weeks'
-- XP, and challenges sent to them and not yet answered.
create or replace function public.notify_social(p_token text, p_week date)
returns table (kind text, user_id uuid, other_id uuid, other_nickname text, my_xp integer, other_xp integer, ref text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.notify_check(p_token);
  return query
  select 'friend'::text, f.follower, f.followee, (select pc.nickname from public.public_card(f.followee) pc),
         public.league_week_xp(f.follower, p_week), public.league_week_xp(f.followee, p_week), null::text
    from public.follows f
   where exists (select 1 from public.follows back where back.follower = f.followee and back.followee = f.follower)
     and exists (select 1 from public.push_subscriptions p where p.user_id = f.follower)
  union all
  select 'challenge'::text, c.opponent, c.challenger, (select pc.nickname from public.public_card(c.challenger) pc), 0, 0, c.id::text
    from public.challenges c
   where c.accepted_at is null and c.settled_at is null and c.week_start = p_week
     and exists (select 1 from public.push_subscriptions p where p.user_id = c.opponent);
end;
$$;

revoke all on function public.notify_social(text, date) from anon, authenticated, public;
grant execute on function public.notify_social(text, date) to anon, authenticated;

-- Claims reminders before they are sent, and remembers what was seen. Returns
-- the devices of the reminders newly claimed: one already sent today, or
-- claimed by a run at the same moment, comes back with none.
--   p_sends   [{user, day, key}]
--   p_state   [{user, key, value}]
create or replace function public.notify_claim(p_token text, p_sends jsonb, p_state jsonb)
returns table (user_id uuid, day date, key text, endpoint text, p256dh text, auth text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.notify_check(p_token);
  insert into public.notify_state as s (user_id, key, value)
  select e."user", e.key, e.value
    from jsonb_to_recordset(coalesce(p_state, '[]'::jsonb)) as e("user" uuid, key text, value text)
  on conflict on constraint notify_state_pkey do update set value = excluded.value;

  return query
  with claimed as (
    insert into public.notifications_sent as n (user_id, day, key)
    select e."user", e.day, e.key
      from jsonb_to_recordset(coalesce(p_sends, '[]'::jsonb)) as e("user" uuid, day date, key text)
    on conflict do nothing
    returning n.user_id, n.day, n.key
  )
  select c.user_id, c.day, c.key, p.endpoint, p.p256dh, p.auth
    from claimed c
    join public.push_subscriptions p on p.user_id = c.user_id;
end;
$$;

revoke all on function public.notify_claim(text, jsonb, jsonb) from anon, authenticated, public;
grant execute on function public.notify_claim(text, jsonb, jsonb) to anon, authenticated;

-- Forgets devices the push service says are gone (HTTP 404 or 410).
create or replace function public.notify_gone(p_token text, p_endpoints text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.notify_check(p_token);
  delete from public.push_subscriptions p where p.endpoint = any (coalesce(p_endpoints, '{}'::text[]));
end;
$$;

revoke all on function public.notify_gone(text, text[]) from anon, authenticated, public;
grant execute on function public.notify_gone(text, text[]) to anon, authenticated;

-- The API reads functions from a cache; it is told to read them again.
notify pgrst, 'reload schema';
