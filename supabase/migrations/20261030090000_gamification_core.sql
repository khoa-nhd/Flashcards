-- Version 17: the game's core (docs/gamification-plan.md, phase 1).
--
-- XP, levels, quests, badges, streak freezes and rewards waiting to be
-- claimed. The rules live in the app (shared/gamification/), so this file only
-- stores what the server has worked out, and only through game_commit: a
-- signed change, so a reviewer cannot write XP of their own with the public
-- key. Nothing here touches the schedule.
--
-- Additive only, and safe to run again. After running it, set the signing key
-- once (the same value as GAME_SIGNING_KEY on the server):
--   insert into public.game_signing_key (key) values ('<64 hex characters>')
--     on conflict (id) do update set key = excluded.key;

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 17 $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per account: the version guards against two changes made from the
-- same snapshot; the state is the engine's own (GameStateData).
create table if not exists public.game_state (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  version bigint not null default 0,
  total_xp bigint not null default 0,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Every time XP was earned (or taken back, as a negative amount). The key makes
-- counting the same answer, goal day or reward twice impossible.
create table if not exists public.xp_ledger (
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('answer', 'goal', 'reward')),
  source_id text not null,
  amount integer not null,
  base integer not null,
  bonus integer not null default 0,
  reason text not null,
  earned_at timestamptz not null,
  earned_on date not null,
  primary key (user_id, source, source_id)
);

create index if not exists xp_ledger_user_day_idx on public.xp_ledger (user_id, earned_on);

create table if not exists public.game_quests (
  user_id uuid not null references auth.users (id) on delete cascade,
  period text not null check (period in ('day', 'week')),
  period_start date not null,
  slot smallint not null check (slot >= 0),
  kind text not null,
  target integer not null check (target > 0),
  reward integer not null check (reward >= 0),
  progress integer not null default 0 check (progress >= 0),
  completed_at timestamptz,
  primary key (user_id, period, period_start, slot)
);

create table if not exists public.game_badges (
  user_id uuid not null references auth.users (id) on delete cascade,
  badge text not null,
  tier smallint not null check (tier > 0),
  earned_at timestamptz not null default now(),
  primary key (user_id, badge, tier)
);

create table if not exists public.game_freezes (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  granted_on date not null,
  used_on date
);

create unique index if not exists game_freezes_used_idx on public.game_freezes (user_id, used_on) where used_on is not null;

create table if not exists public.game_rewards (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

create index if not exists game_rewards_open_idx on public.game_rewards (user_id, created_at) where claimed_at is null;

-- The key changes are signed with. Nobody but the functions below can read it.
create table if not exists public.game_signing_key (
  id boolean primary key default true check (id),
  key text not null check (char_length(key) >= 32)
);

-- ---------------------------------------------------------------------------
-- Access: each account reads its own rows; nobody writes them directly
-- ---------------------------------------------------------------------------

alter table public.game_state enable row level security;
alter table public.xp_ledger enable row level security;
alter table public.game_quests enable row level security;
alter table public.game_badges enable row level security;
alter table public.game_freezes enable row level security;
alter table public.game_rewards enable row level security;
alter table public.game_signing_key enable row level security;

drop policy if exists game_state_select on public.game_state;
create policy game_state_select on public.game_state for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists xp_ledger_select on public.xp_ledger;
create policy xp_ledger_select on public.xp_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists game_quests_select on public.game_quests;
create policy game_quests_select on public.game_quests for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists game_badges_select on public.game_badges;
create policy game_badges_select on public.game_badges for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists game_freezes_select on public.game_freezes;
create policy game_freezes_select on public.game_freezes for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists game_rewards_select on public.game_rewards;
create policy game_rewards_select on public.game_rewards for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.game_state, public.xp_ledger, public.game_quests, public.game_badges,
  public.game_freezes, public.game_rewards, public.game_signing_key from anon, authenticated, public;
grant select on public.game_state, public.xp_ledger, public.game_quests, public.game_badges,
  public.game_freezes, public.game_rewards to authenticated;

-- ---------------------------------------------------------------------------
-- Reading what the engine needs
-- ---------------------------------------------------------------------------

-- Answers not yet in the ledger, oldest first, with what decides their XP
-- worked out the same way study_day_counts does.
create or replace function public.game_pending_answers(p_limit integer)
returns table (
  id uuid,
  kind text,
  undoes uuid,
  answered_at timestamptz,
  answered_on date,
  is_new boolean,
  counted boolean,
  was_due boolean,
  duration_ms integer,
  mode text,
  mastered boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with zone as (
    select coalesce(
      (select s.time_zone from public.user_settings s where s.user_id = (select auth.uid())),
      'UTC'
    ) as name
  )
  select
    l.id,
    l.kind,
    l.undoes_log_id,
    l.reviewed_at,
    l.reviewed_on,
    coalesce(l.counted_as_new, false),
    coalesce(l.counted_toward_schedule, true),
    case
      when l.kind <> 'review' or coalesce(l.counted_as_new, false) then false
      when jsonb_typeof(l.fsrs_before) = 'object' and l.fsrs_before ? 'due'
        then (l.fsrs_before ->> 'due')::timestamptz
           < ((l.reviewed_on + 1)::timestamp at time zone (select z.name from zone z))
      else coalesce(l.due_on_before, l.review_date_before) is null
        or coalesce(l.due_on_before, l.review_date_before) <= l.reviewed_on
    end,
    l.duration_ms,
    l.review_mode,
    coalesce(
      l.kind = 'review'
        and coalesce(l.counted_toward_schedule, true)
        and jsonb_typeof(l.fsrs_after) = 'object'
        and (l.fsrs_after ->> 'stability')::double precision >= 365
        and coalesce(case when jsonb_typeof(l.fsrs_before) = 'object' then (l.fsrs_before ->> 'stability')::double precision end, 0) < 365,
      false
    )
  from public.review_logs l
  where l.user_id = (select auth.uid())
    and l.kind in ('review', 'practice', 'undo')
    and not exists (
      select 1 from public.xp_ledger x
       where x.user_id = l.user_id and x.source = 'answer' and x.source_id = l.id::text
    )
  order by l.reviewed_at, l.id
  limit greatest(1, least(coalesce(p_limit, 1000), 5000))
$$;

revoke all on function public.game_pending_answers(integer) from anon, authenticated, public;
grant execute on function public.game_pending_answers(integer) to authenticated;

-- The totals the badges are read from. Answers taken back do not count.
create or replace function public.game_badge_metrics()
returns table (
  words_studied integer,
  mastered integer,
  reviews integer,
  practice integer,
  duration_ms bigint,
  night_answers integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with zone as (
    select coalesce(
      (select s.time_zone from public.user_settings s where s.user_id = (select auth.uid())),
      'UTC'
    ) as name
  ),
  standing as (
    select l.vocabulary_id, l.kind, l.duration_ms,
           extract(hour from l.reviewed_at at time zone (select z.name from zone z)) as hour
      from public.review_logs l
     where l.user_id = (select auth.uid())
       and l.kind in ('review', 'practice')
       and not exists (select 1 from public.review_logs u where u.undoes_log_id = l.id)
  )
  select
    (select count(distinct s.vocabulary_id) from standing s where s.kind = 'review')::integer,
    (select count(*)
       from public.card_states c
       join public.vocabulary v on v.id = c.vocabulary_id and v.user_id = c.user_id
      where c.user_id = (select auth.uid())
        and v.deleted_at is null
        and c.suspended_at is null
        and c.fsrs_stability >= 365)::integer,
    (select count(*) from standing s where s.kind = 'review')::integer,
    (select count(*) from standing s where s.kind = 'practice')::integer,
    (select coalesce(sum(s.duration_ms), 0) from standing s)::bigint,
    (select count(*) from standing s where s.hour >= 23 or s.hour < 4)::integer
$$;

revoke all on function public.game_badge_metrics() from anon, authenticated, public;
grant execute on function public.game_badge_metrics() to authenticated;

-- ---------------------------------------------------------------------------
-- Writing: one signed change at a time
-- ---------------------------------------------------------------------------

-- HMAC-SHA256 (RFC 2104) with the built-in sha256, so no extension is needed.
create or replace function public.game_hmac(p_key text, p_message text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key bytea := convert_to(p_key, 'UTF8');
  v_inner bytea;
  v_outer bytea;
  v_at integer;
begin
  if length(v_key) > 64 then
    v_key := sha256(v_key);
  end if;
  v_key := v_key || decode(repeat('00', 64 - length(v_key)), 'hex');
  v_inner := v_key;
  v_outer := v_key;
  for v_at in 0..63 loop
    v_inner := set_byte(v_inner, v_at, get_byte(v_key, v_at) # 54);
    v_outer := set_byte(v_outer, v_at, get_byte(v_key, v_at) # 92);
  end loop;
  return encode(sha256(v_outer || sha256(v_inner || convert_to(p_message, 'UTF8'))), 'hex');
end;
$$;

revoke all on function public.game_hmac(text, text) from anon, authenticated, public;

-- Applies a change the server worked out and signed (server/game-service.ts):
--   user      the account it is for; must be the caller
--   version   the game_state version it was made from; any other and nothing happens
--   state     the engine's state after it
--   ledger, quests, badges, freezes, rewards   rows to add (or, for quests and
--             freezes, to bring forward)
--   claimed   rewards claimed by it
-- Outcomes: ok, stale (made from an older version: work it out again).
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

  update public.game_state s
     set version = s.version + 1,
         state = coalesce(v_change -> 'state', s.state),
         total_xp = (select coalesce(sum(x.amount), 0) from public.xp_ledger x where x.user_id = v_user),
         updated_at = now()
   where s.user_id = v_user;

  return query select 'ok'::text, s.version, s.total_xp from public.game_state s where s.user_id = v_user;
end;
$$;

revoke all on function public.game_commit(text, text) from anon, authenticated, public;
grant execute on function public.game_commit(text, text) to authenticated;

-- The API reads functions from a cache; it is told to read them again.
notify pgrst, 'reload schema';
