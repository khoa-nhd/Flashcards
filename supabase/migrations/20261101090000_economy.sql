-- Version 19: the economy (docs/gamification-plan.md, phase 3).
--
-- Stardust, items, chests, companions, the weekly boss and events. As in
-- versions 17 and 18, the rules are the server's (shared/gamification): this
-- file only keeps what the server signed, and refuses a change that would
-- leave stardust below nothing. Chests are drawn by the server with a secure
-- random source before the change is signed, and a claimed reward cannot be
-- claimed again, so a chest is opened once.
--
-- Additive only, and safe to run again.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 19 $$;

create table if not exists public.stardust_ledger (
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('reward', 'chest', 'shop', 'set')),
  source_id text not null,
  amount integer not null,
  reason text not null,
  earned_at timestamptz not null default now(),
  primary key (user_id, source, source_id)
);

create table if not exists public.inventory (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null check (char_length(item_id) between 1 and 60),
  source text not null,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.game_state add column if not exists stardust bigint not null default 0;

-- Events the admin can switch off for everyone; on unless switched off.
create table if not exists public.game_events (
  event text primary key check (event in ('golden_hour', 'sunday', 'monthly', 'boss')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.stardust_ledger enable row level security;
alter table public.inventory enable row level security;
alter table public.game_events enable row level security;

drop policy if exists stardust_ledger_select on public.stardust_ledger;
create policy stardust_ledger_select on public.stardust_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists inventory_select on public.inventory;
create policy inventory_select on public.inventory for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists game_events_select on public.game_events;
create policy game_events_select on public.game_events for select to authenticated using (true);

revoke all on public.stardust_ledger, public.inventory, public.game_events from anon, authenticated, public;
grant select on public.stardust_ledger, public.inventory, public.game_events to authenticated;

-- ---------------------------------------------------------------------------
-- Writing: the signed change of version 17, with stardust and items
-- ---------------------------------------------------------------------------

-- As in version 17, and also:
--   stardust    stardust entries to add (negative for a purchase)
--   inventory   items to add
-- A change that would leave less than no stardust is refused whole (23514).
create or replace function public.game_commit(p_payload text, p_signature text)
returns table (outcome text, version bigint, total_xp bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_change jsonb;
  v_current bigint;
  v_stardust bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select k.key into v_key from public.game_signing_key k;
  if v_key is null then
    raise exception 'the game signing key is not set' using errcode = '55000';
  end if;
  if p_payload is null or p_signature is null or public.game_hmac(v_key, p_payload) <> lower(p_signature) then
    raise exception 'the change is not signed by the server' using errcode = '42501';
  end if;
  v_change := p_payload::jsonb;
  if (v_change ->> 'user')::uuid is distinct from v_user then
    raise exception 'the change is for another account' using errcode = '42501';
  end if;

  insert into public.game_state (user_id) values (v_user) on conflict (user_id) do nothing;
  select s.version into v_current from public.game_state s where s.user_id = v_user for update;
  if v_current <> (v_change ->> 'version')::bigint then
    return query select 'stale'::text, s.version, s.total_xp from public.game_state s where s.user_id = v_user;
    return;
  end if;

  insert into public.xp_ledger (user_id, source, source_id, amount, base, bonus, reason, earned_at, earned_on)
  select v_user, e.source, e."sourceId", e.amount, e.base, e.bonus, e.reason, e.at, e."on"
    from jsonb_to_recordset(coalesce(v_change -> 'ledger', '[]'::jsonb))
      as e(source text, "sourceId" text, amount integer, base integer, bonus integer, reason text, at timestamptz, "on" date)
  on conflict do nothing;

  insert into public.game_quests as q (user_id, period, period_start, slot, kind, target, reward, progress, completed_at)
  select v_user, e.period, e.start, e.slot, e.kind, e.target, e.reward, e.progress, e."completedAt"
    from jsonb_to_recordset(coalesce(v_change -> 'quests', '[]'::jsonb))
      as e(period text, start date, slot smallint, kind text, target integer, reward integer, progress integer, "completedAt" timestamptz)
  on conflict (user_id, period, period_start, slot) do update
    set progress = excluded.progress,
        completed_at = coalesce(q.completed_at, excluded.completed_at);

  insert into public.game_badges (user_id, badge, tier)
  select v_user, e.badge, e.tier
    from jsonb_to_recordset(coalesce(v_change -> 'badges', '[]'::jsonb)) as e(badge text, tier smallint)
  on conflict do nothing;

  insert into public.game_freezes as f (id, user_id, granted_on, used_on)
  select e.id, v_user, e."grantedOn", e."usedOn"
    from jsonb_to_recordset(coalesce(v_change -> 'freezes', '[]'::jsonb)) as e(id uuid, "grantedOn" date, "usedOn" date)
  on conflict (id) do update
    set used_on = coalesce(f.used_on, excluded.used_on)
    where f.user_id = v_user;

  insert into public.game_rewards (id, user_id, kind, payload, created_at)
  select e.id, v_user, e.kind, coalesce(e.payload, '{}'::jsonb), coalesce(e."createdAt", now())
    from jsonb_to_recordset(coalesce(v_change -> 'rewards', '[]'::jsonb))
      as e(id uuid, kind text, payload jsonb, "createdAt" timestamptz)
  on conflict (id) do nothing;

  update public.game_rewards r
     set claimed_at = now()
   where r.user_id = v_user
     and r.claimed_at is null
     and r.id::text in (select jsonb_array_elements_text(coalesce(v_change -> 'claimed', '[]'::jsonb)));

  insert into public.stardust_ledger (user_id, source, source_id, amount, reason, earned_at)
  select v_user, e.source, e."sourceId", e.amount, e.reason, coalesce(e.at, now())
    from jsonb_to_recordset(coalesce(v_change -> 'stardust', '[]'::jsonb))
      as e(source text, "sourceId" text, amount integer, reason text, at timestamptz)
  on conflict do nothing;

  insert into public.inventory (user_id, item_id, source)
  select v_user, e.item, e.source
    from jsonb_to_recordset(coalesce(v_change -> 'inventory', '[]'::jsonb)) as e(item text, source text)
  on conflict do nothing;

  select coalesce(sum(l.amount), 0) into v_stardust from public.stardust_ledger l where l.user_id = v_user;
  if v_stardust < 0 then
    raise exception 'not enough stardust' using errcode = '23514';
  end if;

  update public.game_state s
     set version = s.version + 1,
         state = coalesce(v_change -> 'state', s.state),
         total_xp = (select coalesce(sum(x.amount), 0) from public.xp_ledger x where x.user_id = v_user),
         stardust = v_stardust,
         updated_at = now()
   where s.user_id = v_user;

  return query select 'ok'::text, s.version, s.total_xp from public.game_state s where s.user_id = v_user;
end;
$$;

revoke all on function public.game_commit(text, text) from anon, authenticated, public;
grant execute on function public.game_commit(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- The weekly boss's health is worked out from practice answers on its words
-- since the week began: remembered ones hurt it, forgotten ones heal it.
-- Practice never moves a schedule, so neither does the boss.
create or replace function public.boss_progress(p_words uuid[], p_from timestamptz)
returns table (correct integer, wrong integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*) filter (where l.answer_correct)::integer,
         count(*) filter (where l.answer_correct = false)::integer
    from public.review_logs l
   where l.user_id = (select auth.uid())
     and l.kind = 'practice'
     and l.vocabulary_id = any (coalesce(p_words, '{}'::uuid[]))
     and l.reviewed_at >= p_from
$$;

revoke all on function public.boss_progress(uuid[], timestamptz) from anon, authenticated, public;
grant execute on function public.boss_progress(uuid[], timestamptz) to authenticated;

-- What a public profile shows off: the items collected and the companions
-- leading. Unless either account blocked the other, or an admin hid it.
create or replace function public.profile_showcase(p_user uuid)
returns table (item_id text, is_leading boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.item_id,
         coalesce((select s.state -> 'pets' -> 'active' ? i.item_id from public.game_state s where s.user_id = p_user), false)
    from public.inventory i
   where i.user_id = p_user
     and exists (select 1 from public.public_profiles p where p.user_id = p_user and not p.hidden_by_admin)
     and not public.blocked_between(p_user, (select auth.uid()))
$$;

revoke all on function public.profile_showcase(uuid) from anon, authenticated, public;
grant execute on function public.profile_showcase(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The signed operations of version 18, and an admin switching events
-- ---------------------------------------------------------------------------

create or replace function public.game_apply(p_payload text, p_signature text)
returns table (result uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_op jsonb;
  v_kind text;
  v_other uuid;
  v_group uuid;
  v_week date;
  v_tier smallint;
  v_entry jsonb;
  v_member jsonb;
  v_invite public.invites;
  v_challenge public.challenges;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select k.key into v_key from public.game_signing_key k;
  if v_key is null then
    raise exception 'the game signing key is not set' using errcode = '55000';
  end if;
  if p_payload is null or p_signature is null or public.game_hmac(v_key, p_payload) <> lower(p_signature) then
    raise exception 'the operation is not signed by the server' using errcode = '42501';
  end if;
  v_op := p_payload::jsonb;
  if (v_op ->> 'user')::uuid is distinct from v_user then
    raise exception 'the operation is for another account' using errcode = '42501';
  end if;
  if (v_op ->> 'exp')::timestamptz < now() then
    raise exception 'the operation has expired' using errcode = '42501';
  end if;
  v_kind := v_op ->> 'op';
  v_other := (v_op ->> 'other')::uuid;

  if v_kind like 'admin_%' and not exists (select 1 from public.app_admins a where a.user_id = v_user) then
    raise exception 'only an admin can do that' using errcode = '42501';
  end if;
  if v_kind in ('follow', 'challenge', 'invite_accept') and v_other is not null and public.blocked_between(v_user, v_other) then
    raise exception 'that account cannot be reached' using errcode = '42501';
  end if;

  case v_kind
    when 'profile' then
      insert into public.public_profiles (user_id, nickname, frame, title, in_leagues)
      values (v_user, v_op ->> 'nickname', v_op ->> 'frame', v_op ->> 'title', coalesce((v_op ->> 'inLeagues')::boolean, true))
      on conflict (user_id) do update
        set nickname = coalesce(excluded.nickname, public_profiles.nickname),
            frame = case when v_op ? 'frame' then excluded.frame else public_profiles.frame end,
            title = case when v_op ? 'title' then excluded.title else public_profiles.title end,
            in_leagues = case when v_op ? 'inLeagues' then excluded.in_leagues else public_profiles.in_leagues end;

    when 'league_join' then
      v_week := (v_op ->> 'week')::date;
      v_tier := (v_op ->> 'tier')::smallint;
      select m.group_id into v_group from public.league_members m where m.user_id = v_user and m.week_start = v_week;
      if v_group is not null then
        result := v_group;
        return next;
        return;
      end if;
      select g.id into v_group
        from public.league_groups g
       where g.week_start = v_week and g.tier = v_tier and g.finalized_at is null
         and g.created_at > now() - interval '24 hours'
         and (select count(*) from public.league_members m where m.group_id = g.id) < 20
       order by g.created_at
       limit 1
       for update skip locked;
      if v_group is null then
        insert into public.league_groups (week_start, tier) values (v_week, v_tier) returning id into v_group;
      end if;
      insert into public.league_members (group_id, user_id, week_start) values (v_group, v_user, v_week)
        on conflict (user_id, week_start) do nothing;
      select m.group_id into v_group from public.league_members m where m.user_id = v_user and m.week_start = v_week;
      result := v_group;
      return next;
      return;

    when 'league_settle' then
      for v_entry in select * from jsonb_array_elements(coalesce(v_op -> 'groups', '[]'::jsonb)) loop
        v_group := (v_entry ->> 'id')::uuid;
        -- Settled once: a second settling of the same group changes nothing.
        update public.league_groups g set finalized_at = now() where g.id = v_group and g.finalized_at is null;
        if not found then
          continue;
        end if;
        for v_member in select * from jsonb_array_elements(coalesce(v_entry -> 'members', '[]'::jsonb)) loop
          update public.league_members m
             set final_rank = (v_member ->> 'rank')::smallint,
                 final_xp = (v_member ->> 'xp')::integer,
                 outcome = v_member ->> 'outcome'
           where m.group_id = v_group and m.user_id = (v_member ->> 'user')::uuid;
          insert into public.league_tiers (user_id, tier) values ((v_member ->> 'user')::uuid, (v_member ->> 'tier')::smallint)
            on conflict (user_id) do update set tier = excluded.tier, updated_at = now();
          insert into public.game_rewards (id, user_id, kind, payload)
          values (gen_random_uuid(), (v_member ->> 'user')::uuid, 'league', coalesce(v_member -> 'reward', '{}'::jsonb));
        end loop;
      end loop;

    when 'follow' then
      insert into public.follows (follower, followee) values (v_user, v_other) on conflict do nothing;
    when 'unfollow' then
      delete from public.follows f where f.follower = v_user and f.followee = v_other;
    when 'block' then
      insert into public.blocks (blocker, blocked) values (v_user, v_other) on conflict do nothing;
      delete from public.follows f where (f.follower = v_user and f.followee = v_other) or (f.follower = v_other and f.followee = v_user);
    when 'unblock' then
      delete from public.blocks b where b.blocker = v_user and b.blocked = v_other;

    when 'invite' then
      insert into public.invites (token, user_id, expires_at)
      values (v_op ->> 'token', v_user, (v_op ->> 'expires')::timestamptz);
    when 'invite_accept' then
      select * into v_invite from public.invites i where i.token = v_op ->> 'token' and i.expires_at > now();
      if v_invite.token is null or v_invite.user_id = v_user then
        raise exception 'that invite link does not work' using errcode = '22023';
      end if;
      if public.blocked_between(v_user, v_invite.user_id) then
        raise exception 'that account cannot be reached' using errcode = '42501';
      end if;
      insert into public.follows (follower, followee) values (v_user, v_invite.user_id), (v_invite.user_id, v_user)
        on conflict do nothing;

    when 'challenge' then
      if not (exists (select 1 from public.follows f where f.follower = v_user and f.followee = v_other)
              and exists (select 1 from public.follows f where f.follower = v_other and f.followee = v_user)) then
        raise exception 'challenges are between friends' using errcode = '22023';
      end if;
      insert into public.challenges (week_start, challenger, opponent)
      values ((v_op ->> 'week')::date, v_user, v_other)
      on conflict do nothing;
    when 'challenge_accept' then
      update public.challenges c set accepted_at = now()
       where c.id = (v_op ->> 'id')::uuid and c.opponent = v_user and c.accepted_at is null;
    when 'challenge_settle' then
      select * into v_challenge from public.challenges c
       where c.id = (v_op ->> 'id')::uuid and v_user in (c.challenger, c.opponent) and c.settled_at is null
       for update;
      if v_challenge.id is not null then
        update public.challenges c set settled_at = now(), winner = (v_op ->> 'winner')::uuid where c.id = v_challenge.id;
        for v_member in select * from jsonb_array_elements(coalesce(v_op -> 'rewards', '[]'::jsonb)) loop
          if (v_member ->> 'user')::uuid in (v_challenge.challenger, v_challenge.opponent) then
            insert into public.game_rewards (id, user_id, kind, payload)
            values (gen_random_uuid(), (v_member ->> 'user')::uuid, 'challenge', coalesce(v_member -> 'payload', '{}'::jsonb));
          end if;
        end loop;
      end if;

    when 'report' then
      insert into public.reports (reporter, target, reason) values (v_user, v_other, v_op ->> 'reason');

    when 'admin_rename' then
      update public.public_profiles p set nickname = v_op ->> 'nickname' where p.user_id = v_other;
      update public.reports r set resolved_at = now() where r.target = v_other and r.resolved_at is null;
    when 'admin_hide' then
      update public.public_profiles p set hidden_by_admin = coalesce((v_op ->> 'hidden')::boolean, true) where p.user_id = v_other;
      update public.reports r set resolved_at = now() where r.target = v_other and r.resolved_at is null;
    when 'admin_resolve' then
      update public.reports r set resolved_at = now() where r.target = v_other and r.resolved_at is null;
    when 'admin_event' then
      insert into public.game_events (event, enabled) values (v_op ->> 'event', coalesce((v_op ->> 'enabled')::boolean, true))
        on conflict (event) do update set enabled = excluded.enabled, updated_at = now();

    else
      raise exception 'unknown operation %', v_kind using errcode = '22023';
  end case;
  result := null;
  return next;
end;
$$;

revoke all on function public.game_apply(text, text) from anon, authenticated, public;
grant execute on function public.game_apply(text, text) to authenticated;

-- The API reads functions from a cache; it is told to read them again.
notify pgrst, 'reload schema';
