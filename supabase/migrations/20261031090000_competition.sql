-- Version 18: competition (docs/gamification-plan.md, phase 2).
--
-- Nicknames, weekly leagues, friends, public profiles, reports and admin, and
-- the write lockdown that makes XP fit to compare between strangers.
--
-- Every write here goes through game_apply: an operation the server worked out
-- and signed with the same key as game_commit, valid for a minute. Other
-- accounts' rows are only ever read through functions that return their public
-- columns: nickname, frame, title, level, league, streak, badges. Never an
-- email, a word or a schedule.
--
-- Additive only, and safe to run again.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 18 $$;

-- ---------------------------------------------------------------------------
-- The write lockdown
-- ---------------------------------------------------------------------------

-- When the database recorded the answer, by its own clock: the reviewer's
-- reviewed_at can be backdated, so limits on how fast XP is earned use this.
-- Answers saved before this version have none (filling them in now would
-- stamp the whole history with one moment), and the limits skip them.
alter table public.review_logs add column if not exists recorded_at timestamptz;
alter table public.review_logs alter column recorded_at set default now();

-- The history, the schedules and the met days are written only by the
-- functions that work them out (record_fsrs_review, record_practice, undo,
-- record_study_day and the rest), never row by row through the API's table
-- endpoint: a row written straight to the table could claim any answer, or a
-- word at Master on a public profile. Outside an API request
-- (the SQL Editor, the tests) there is no request path and nothing is stopped.
create or replace function public.refuse_table_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_path text := current_setting('request.path', true);
begin
  if v_path is not null and v_path <> '' and v_path not like '/rpc/%' then
    raise exception '% is written through the app''s functions only', tg_table_name using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists review_logs_through_functions on public.review_logs;
create trigger review_logs_through_functions before insert or update on public.review_logs
  for each row execute function public.refuse_table_writes();

drop trigger if exists card_states_through_functions on public.card_states;
create trigger card_states_through_functions before insert or update on public.card_states
  for each row execute function public.refuse_table_writes();

drop trigger if exists study_days_through_functions on public.study_days;
create trigger study_days_through_functions before insert or update on public.study_days
  for each row execute function public.refuse_table_writes();

-- The answers the engine counts now say when the database recorded them.
drop function if exists public.game_pending_answers(integer);
create function public.game_pending_answers(p_limit integer)
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
  mastered boolean,
  recorded_at timestamptz
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
    ),
    l.recorded_at
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.public_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 3 and 20),
  frame text,
  title text,
  in_leagues boolean not null default true,
  hidden_by_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists public_profiles_nickname_idx on public.public_profiles (lower(nickname));

create table if not exists public.league_tiers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier smallint not null default 1 check (tier between 1 and 8),
  updated_at timestamptz not null default now()
);

create table if not exists public.league_groups (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  tier smallint not null check (tier between 1 and 8),
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create index if not exists league_groups_week_idx on public.league_groups (week_start, tier);

create table if not exists public.league_members (
  group_id uuid not null references public.league_groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  joined_at timestamptz not null default now(),
  final_rank smallint,
  final_xp integer,
  outcome text check (outcome in ('up', 'down', 'stay')),
  primary key (group_id, user_id),
  unique (user_id, week_start)
);

create table if not exists public.follows (
  follower uuid not null references auth.users (id) on delete cascade,
  followee uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);

create table if not exists public.blocks (
  blocker uuid not null references auth.users (id) on delete cascade,
  blocked uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

create table if not exists public.invites (
  token text primary key check (char_length(token) >= 16),
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  challenger uuid not null references auth.users (id) on delete cascade,
  opponent uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  settled_at timestamptz,
  winner uuid,
  unique (week_start, challenger, opponent),
  check (challenger <> opponent)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references auth.users (id) on delete cascade,
  target uuid not null references auth.users (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 300),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Who may moderate: the owner adds their own user id here, by hand.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.public_profiles enable row level security;
alter table public.league_tiers enable row level security;
alter table public.league_groups enable row level security;
alter table public.league_members enable row level security;
alter table public.follows enable row level security;
alter table public.blocks enable row level security;
alter table public.invites enable row level security;
alter table public.challenges enable row level security;
alter table public.reports enable row level security;
alter table public.app_admins enable row level security;

-- Each account reads its own rows directly; everything about others goes
-- through the functions below. Nobody writes any of these tables directly.
drop policy if exists public_profiles_select on public.public_profiles;
create policy public_profiles_select on public.public_profiles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists league_tiers_select on public.league_tiers;
create policy league_tiers_select on public.league_tiers for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows for select to authenticated
  using (follower = (select auth.uid()) or followee = (select auth.uid()));
drop policy if exists blocks_select on public.blocks;
create policy blocks_select on public.blocks for select to authenticated using (blocker = (select auth.uid()));

revoke all on public.public_profiles, public.league_tiers, public.league_groups, public.league_members,
  public.follows, public.blocks, public.invites, public.challenges, public.reports, public.app_admins
  from anon, authenticated, public;
grant select on public.public_profiles, public.league_tiers, public.follows, public.blocks to authenticated;

-- ---------------------------------------------------------------------------
-- Reading other accounts, public columns only
-- ---------------------------------------------------------------------------

-- The Monday a timestamp's week starts on, in Vietnam's time: leagues share one clock.
create or replace function public.league_week_of(p_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select date_trunc('week', p_at at time zone 'Asia/Ho_Chi_Minh')::date
$$;

-- XP an account earned in a league week (Monday 00:00 to Sunday 24:00, Vietnam).
create or replace function public.league_week_xp(p_user uuid, p_week date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(x.amount), 0)::integer
    from public.xp_ledger x
   where x.user_id = p_user
     and x.earned_at >= (p_week::timestamp at time zone 'Asia/Ho_Chi_Minh')
     and x.earned_at < ((p_week + 7)::timestamp at time zone 'Asia/Ho_Chi_Minh')
$$;

revoke all on function public.league_week_xp(uuid, date) from anon, authenticated, public;

-- An account as others may see it. A profile hidden by an admin shows no nickname.
create or replace function public.public_card(p_user uuid)
returns table (nickname text, frame text, title text, total_xp bigint, tier smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    case when p.hidden_by_admin then null else p.nickname end,
    case when p.hidden_by_admin then null else p.frame end,
    case when p.hidden_by_admin then null else p.title end,
    coalesce((select s.total_xp from public.game_state s where s.user_id = p_user), 0),
    coalesce((select t.tier from public.league_tiers t where t.user_id = p_user), 1::smallint)
  from public.public_profiles p
  where p.user_id = p_user
$$;

revoke all on function public.public_card(uuid) from anon, authenticated, public;

-- Whether either account has blocked the other.
create or replace function public.blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks b
     where (b.blocker = p_a and b.blocked = p_b) or (b.blocker = p_b and b.blocked = p_a)
  )
$$;

revoke all on function public.blocked_between(uuid, uuid) from anon, authenticated, public;

-- The caller's league group this week: every real member's public card and week XP.
-- Bots are not stored; the server adds them from the group's id.
create or replace function public.league_board(p_week date)
returns table (
  group_id uuid,
  group_tier smallint,
  group_created_at timestamptz,
  finalized boolean,
  member_id uuid,
  is_me boolean,
  nickname text,
  frame text,
  title text,
  total_xp bigint,
  week_xp integer,
  joined_at timestamptz,
  final_rank smallint,
  outcome text
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select m.group_id from public.league_members m
     where m.user_id = (select auth.uid()) and m.week_start = p_week
  )
  select g.id, g.tier, g.created_at, g.finalized_at is not null,
         m.user_id, m.user_id = (select auth.uid()),
         c.nickname, c.frame, c.title, coalesce(c.total_xp, 0),
         coalesce(m.final_xp, public.league_week_xp(m.user_id, p_week)),
         m.joined_at, m.final_rank, m.outcome
    from mine
    join public.league_groups g on g.id = mine.group_id
    join public.league_members m on m.group_id = g.id
    left join lateral public.public_card(m.user_id) c on true
$$;

revoke all on function public.league_board(date) from anon, authenticated, public;
grant execute on function public.league_board(date) to authenticated;

-- Every group of a week not yet settled, with each real member's week XP: what
-- the server settles the week from. Week XP is what the league table shows anyway.
create or replace function public.league_unsettled(p_week date)
returns table (group_id uuid, tier smallint, created_at timestamptz, member_id uuid, week_xp integer, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.tier, g.created_at, m.user_id, public.league_week_xp(m.user_id, p_week), m.joined_at
    from public.league_groups g
    join public.league_members m on m.group_id = g.id
   where g.week_start = p_week and g.finalized_at is null
   order by g.id, m.joined_at
$$;

revoke all on function public.league_unsettled(date) from anon, authenticated, public;
grant execute on function public.league_unsettled(date) to authenticated;

-- Weeks before this one that still have groups to settle, oldest first.
create or replace function public.league_weeks_to_settle(p_before date)
returns table (week_start date)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct g.week_start from public.league_groups g
   where g.week_start < p_before and g.finalized_at is null
   order by g.week_start
$$;

revoke all on function public.league_weeks_to_settle(date) from anon, authenticated, public;
grant execute on function public.league_weeks_to_settle(date) to authenticated;

-- A profile by nickname, unless either account blocked the other.
create or replace function public.profile_by_nickname(p_nickname text)
returns table (
  member_id uuid,
  is_me boolean,
  nickname text,
  frame text,
  title text,
  total_xp bigint,
  tier smallint,
  mastered integer,
  following boolean,
  followed_by boolean,
  blocked boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.user_id = (select auth.uid()), c.nickname, c.frame, c.title, c.total_xp, c.tier,
         (select count(*)::integer from public.card_states s
            join public.vocabulary v on v.id = s.vocabulary_id and v.user_id = s.user_id
           where s.user_id = p.user_id and v.deleted_at is null and s.suspended_at is null and s.fsrs_stability >= 365),
         exists (select 1 from public.follows f where f.follower = (select auth.uid()) and f.followee = p.user_id),
         exists (select 1 from public.follows f where f.follower = p.user_id and f.followee = (select auth.uid())),
         exists (select 1 from public.blocks b where b.blocker = (select auth.uid()) and b.blocked = p.user_id)
    from public.public_profiles p
    cross join lateral public.public_card(p.user_id) c
   where lower(p.nickname) = lower(p_nickname)
     and not p.hidden_by_admin
     and not exists (select 1 from public.blocks b where b.blocker = p.user_id and b.blocked = (select auth.uid()))
$$;

revoke all on function public.profile_by_nickname(text) from anon, authenticated, public;
grant execute on function public.profile_by_nickname(text) to authenticated;

-- Nicknames starting with the text typed, for finding friends.
create or replace function public.profile_search(p_query text)
returns table (nickname text, frame text, total_xp bigint, tier smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.nickname, c.frame, c.total_xp, c.tier
    from public.public_profiles p
    cross join lateral public.public_card(p.user_id) c
   where char_length(coalesce(p_query, '')) >= 2
     and lower(p.nickname) like lower(replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_')) || '%'
     and not p.hidden_by_admin
     and p.user_id <> (select auth.uid())
     and not public.blocked_between(p.user_id, (select auth.uid()))
   order by lower(p.nickname)
   limit 20
$$;

revoke all on function public.profile_search(text) from anon, authenticated, public;
grant execute on function public.profile_search(text) to authenticated;

-- Days an account met its goals, or a freeze covered: what its streak, and a
-- streak shared with it, are counted from. Only for the caller, those the
-- caller follows, and those who follow the caller.
create or replace function public.streak_days(p_user uuid)
returns table (day date, covered boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.day, false from public.study_days d
   where d.user_id = p_user and d.met
     and (p_user = (select auth.uid())
          or exists (select 1 from public.follows f where f.follower = (select auth.uid()) and f.followee = p_user)
          or exists (select 1 from public.follows f where f.follower = p_user and f.followee = (select auth.uid())))
  union all
  select f.used_on, true from public.game_freezes f
   where f.user_id = p_user and f.used_on is not null
     and (p_user = (select auth.uid())
          or exists (select 1 from public.follows x where x.follower = (select auth.uid()) and x.followee = p_user)
          or exists (select 1 from public.follows x where x.follower = p_user and x.followee = (select auth.uid())))
$$;

revoke all on function public.streak_days(uuid) from anon, authenticated, public;
grant execute on function public.streak_days(uuid) to authenticated;

-- A public profile's badges.
create or replace function public.profile_badges(p_user uuid)
returns table (badge text, tier smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.badge, max(b.tier) from public.game_badges b
   where b.user_id = p_user
     and exists (select 1 from public.public_profiles p where p.user_id = p_user and not p.hidden_by_admin)
     and not public.blocked_between(p_user, (select auth.uid()))
   group by b.badge
$$;

revoke all on function public.profile_badges(uuid) from anon, authenticated, public;
grant execute on function public.profile_badges(uuid) to authenticated;

-- The caller's friends (followed and following back) and the rest they follow,
-- with this week's XP; the server adds streaks.
create or replace function public.friends_list(p_week date)
returns table (member_id uuid, nickname text, frame text, total_xp bigint, tier smallint, week_xp integer, mutual boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select f.followee, c.nickname, c.frame, c.total_xp, c.tier, public.league_week_xp(f.followee, p_week),
         exists (select 1 from public.follows back where back.follower = f.followee and back.followee = f.follower)
    from public.follows f
    cross join lateral public.public_card(f.followee) c
   where f.follower = (select auth.uid())
$$;

revoke all on function public.friends_list(date) from anon, authenticated, public;
grant execute on function public.friends_list(date) to authenticated;

-- Challenges the caller is in, with the other side's nickname and both sides' week XP.
create or replace function public.challenges_list()
returns table (
  id uuid,
  week_start date,
  mine boolean,
  other_id uuid,
  other_nickname text,
  accepted boolean,
  settled boolean,
  won boolean,
  my_xp integer,
  other_xp integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.week_start, c.challenger = (select auth.uid()),
         case when c.challenger = (select auth.uid()) then c.opponent else c.challenger end,
         (select pc.nickname from public.public_card(case when c.challenger = (select auth.uid()) then c.opponent else c.challenger end) pc),
         c.accepted_at is not null, c.settled_at is not null, c.winner = (select auth.uid()),
         public.league_week_xp((select auth.uid()), c.week_start),
         public.league_week_xp(case when c.challenger = (select auth.uid()) then c.opponent else c.challenger end, c.week_start)
    from public.challenges c
   where (select auth.uid()) in (c.challenger, c.opponent)
   order by c.week_start desc, c.created_at desc
   limit 50
$$;

revoke all on function public.challenges_list() from anon, authenticated, public;
grant execute on function public.challenges_list() to authenticated;

-- Reports waiting for an admin.
create or replace function public.admin_reports()
returns table (id uuid, target_id uuid, nickname text, hidden boolean, reason text, created_at timestamptz, reports integer)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.target, p.nickname, p.hidden_by_admin, r.reason, r.created_at,
         (select count(*)::integer from public.reports o where o.target = r.target and o.resolved_at is null)
    from public.reports r
    join public.public_profiles p on p.user_id = r.target
   where r.resolved_at is null
     and exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
   order by r.created_at
   limit 200
$$;

revoke all on function public.admin_reports() from anon, authenticated, public;
grant execute on function public.admin_reports() to authenticated;

-- Whether the caller is an admin.
create or replace function public.is_app_admin()
returns table (admin boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
$$;

-- The caller's own side: nickname and settings (null before the first visit),
-- league tier, and XP this league week.
create or replace function public.competition_me(p_week date)
returns table (nickname text, frame text, title text, in_leagues boolean, hidden boolean, tier smallint, week_xp integer, total_xp bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.nickname, p.frame, p.title, coalesce(p.in_leagues, true), coalesce(p.hidden_by_admin, false),
         coalesce((select t.tier from public.league_tiers t where t.user_id = (select auth.uid())), 1::smallint),
         (select coalesce(sum(x.amount), 0)::integer from public.xp_ledger x
           where x.user_id = (select auth.uid())
             and x.earned_at >= (p_week::timestamp at time zone 'Asia/Ho_Chi_Minh')
             and x.earned_at < ((p_week + 7)::timestamp at time zone 'Asia/Ho_Chi_Minh')),
         coalesce((select s.total_xp from public.game_state s where s.user_id = (select auth.uid())), 0)
    from (select 1) one
    left join public.public_profiles p on p.user_id = (select auth.uid())
$$;

revoke all on function public.competition_me(date) from anon, authenticated, public;
grant execute on function public.competition_me(date) to authenticated;

revoke all on function public.is_app_admin() from anon, authenticated, public;
grant execute on function public.is_app_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Writing: signed operations
-- ---------------------------------------------------------------------------

-- One operation the server signed (server/competition-service.ts):
--   user  the account it is for; must be the caller
--   exp   when it stops being valid (a minute after signing), so it cannot be replayed later
--   op    what to do, with its own fields:
--     profile          nickname, frame, title, inLeagues: set what is given (nickname taken: 23505)
--     league_join      week, tier: join an open group of the tier this week, or start one
--     league_settle    week, groups: [{id, members: [{user, rank, xp, outcome, tier}]}]
--     follow / unfollow / block / unblock   other
--     invite           token, expires
--     invite_accept    token: follow each other
--     challenge        other, week; challenge_accept  id; challenge_settle  id, winner, rewards
--     report           other, reason
--     admin_rename     other, nickname; admin_hide  other, hidden; admin_resolve  other
-- Returns one row: the group id for league_join, and null otherwise.
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
