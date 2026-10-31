-- Version 21: PvP word duels (docs/gamification-plan.md, phase 5).
--
-- The server is the referee: it builds each match's questions and seals each
-- right answer with its own key before storing it, so the two players can read
-- their match but never the answer to a question before answering. Every
-- write is an operation the server signed (pvp_apply), as in versions 17 to 19.
--
-- Additive only, and safe to run again. Needs version 20.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 21 $$;

create table if not exists public.pvp_ratings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  rating integer not null default 1000,
  season text not null,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  -- The warning that the other player will see some of one's words was shown.
  consented boolean not null default false,
  abandoned_on date,
  abandons integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.pvp_queue (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mode text not null check (mode in ('ranked', 'friend')),
  rating integer not null,
  -- The words this player brings: what the other side's questions are made of.
  pool jsonb not null default '[]'::jsonb,
  -- A friend invited by name, for a friend match.
  target uuid references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  claimed_by uuid,
  claimed_at timestamptz,
  -- Set when the match is made, so the one who waited finds it.
  match_id uuid
);

create table if not exists public.pvp_matches (
  id uuid primary key,
  mode text not null check (mode in ('ranked', 'friend', 'rival')),
  player_a uuid not null references auth.users (id) on delete cascade,
  player_b uuid references auth.users (id) on delete cascade,
  -- A simulated rival in place of player b: its name, rating and companion. Never marked as such to the player.
  rival jsonb,
  season text not null,
  state jsonb not null,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  winner text check (winner in ('a', 'b', 'draw')),
  settled boolean not null default false
);

create index if not exists pvp_matches_a_idx on public.pvp_matches (player_a, created_at desc);
create index if not exists pvp_matches_b_idx on public.pvp_matches (player_b, created_at desc);

create table if not exists public.pvp_questions (
  match_id uuid not null references public.pvp_matches (id) on delete cascade,
  idx smallint not null,
  direction text not null check (direction in ('en-vi', 'vi-en')),
  prompt text not null,
  options jsonb not null,
  -- The right option and the word, sealed with the server's key (AES-GCM).
  sealed text not null,
  primary key (match_id, idx)
);

create table if not exists public.pvp_answers (
  match_id uuid not null references public.pvp_matches (id) on delete cascade,
  side text not null check (side in ('a', 'b')),
  idx smallint not null,
  choice smallint not null,
  correct boolean not null,
  answered_at timestamptz not null default now(),
  primary key (match_id, side, idx)
);

alter table public.pvp_ratings enable row level security;
alter table public.pvp_queue enable row level security;
alter table public.pvp_matches enable row level security;
alter table public.pvp_questions enable row level security;
alter table public.pvp_answers enable row level security;

drop policy if exists pvp_ratings_select on public.pvp_ratings;
create policy pvp_ratings_select on public.pvp_ratings for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists pvp_queue_select on public.pvp_queue;
create policy pvp_queue_select on public.pvp_queue for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists pvp_matches_select on public.pvp_matches;
create policy pvp_matches_select on public.pvp_matches for select to authenticated
  using ((select auth.uid()) in (player_a, player_b));
drop policy if exists pvp_questions_select on public.pvp_questions;
create policy pvp_questions_select on public.pvp_questions for select to authenticated
  using (exists (select 1 from public.pvp_matches m where m.id = match_id and (select auth.uid()) in (m.player_a, m.player_b)));
drop policy if exists pvp_answers_select on public.pvp_answers;
create policy pvp_answers_select on public.pvp_answers for select to authenticated
  using (exists (select 1 from public.pvp_matches m where m.id = match_id and (select auth.uid()) in (m.player_a, m.player_b)));

revoke all on public.pvp_ratings, public.pvp_queue, public.pvp_matches, public.pvp_questions, public.pvp_answers
  from anon, authenticated, public;
grant select on public.pvp_ratings, public.pvp_queue, public.pvp_matches, public.pvp_questions, public.pvp_answers to authenticated;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- The two sides of a match the caller is in: nickname and rating.
create or replace function public.pvp_sides(p_match uuid)
returns table (side text, nickname text, rating integer, total_xp bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.side, c.nickname, coalesce(r.rating, 1000), coalesce(c.total_xp, 0)
    from public.pvp_matches m
    cross join lateral (values ('a', m.player_a), ('b', m.player_b)) as s(side, member)
    left join lateral public.public_card(s.member) c on true
    left join public.pvp_ratings r on r.user_id = s.member
   where m.id = p_match and (select auth.uid()) in (m.player_a, m.player_b) and s.member is not null
$$;

revoke all on function public.pvp_sides(uuid) from anon, authenticated, public;
grant execute on function public.pvp_sides(uuid) to authenticated;

-- How many matches each side of a match has played today (UTC): from the 21st, rewards are halved.
create or replace function public.pvp_today(p_match uuid)
returns table (side text, matches integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.side,
         (select count(*)::integer from public.pvp_matches o
           where s.member in (o.player_a, o.player_b) and o.created_at >= date_trunc('day', now()))
    from public.pvp_matches m
    cross join lateral (values ('a', m.player_a), ('b', m.player_b)) as s(side, member)
   where m.id = p_match and (select auth.uid()) in (m.player_a, m.player_b) and s.member is not null
$$;

revoke all on function public.pvp_today(uuid) from anon, authenticated, public;
grant execute on function public.pvp_today(uuid) to authenticated;

-- Friends inviting the caller, still waiting.
create or replace function public.pvp_invites()
returns table (nickname text, invited_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.nickname, q.joined_at
    from public.pvp_queue q
    cross join lateral public.public_card(q.user_id) c
   where q.target = (select auth.uid()) and q.mode = 'friend' and q.match_id is null
     and q.joined_at > now() - interval '60 seconds'
     and not public.blocked_between(q.user_id, (select auth.uid()))
$$;

revoke all on function public.pvp_invites() from anon, authenticated, public;
grant execute on function public.pvp_invites() to authenticated;

-- The caller's record against each player met: "You 7 – 5 Minh".
create or replace function public.pvp_head_to_head()
returns table (nickname text, wins integer, losses integer, draws integer)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select case when m.player_a = (select auth.uid()) then m.player_b else m.player_a end as other,
           case when m.winner = 'draw' then 'draw'
                when (m.winner = 'a') = (m.player_a = (select auth.uid())) then 'won' else 'lost' end as result
      from public.pvp_matches m
     where (select auth.uid()) in (m.player_a, m.player_b) and m.player_b is not null and m.winner is not null
  )
  select c.nickname, count(*) filter (where result = 'won')::integer, count(*) filter (where result = 'lost')::integer,
         count(*) filter (where result = 'draw')::integer
    from mine
    cross join lateral public.public_card(mine.other) c
   group by c.nickname
   order by count(*) desc
   limit 20
$$;

revoke all on function public.pvp_head_to_head() from anon, authenticated, public;
grant execute on function public.pvp_head_to_head() to authenticated;

-- ---------------------------------------------------------------------------
-- Writing: signed operations
-- ---------------------------------------------------------------------------

-- One operation the server signed (server/pvp-service.ts), valid for a minute:
--   user, exp   as in game_apply
--   op          what to do:
--     consent                          the warning about words was shown
--     season_close season, rating, reward: carry the caller's rating into a new season
--     queue_join   mode, rating, pool, target
--     queue_leave
--     claim        mode, rating, window, target: take a waiting opponent; returns their row
--     match_create id, mode, opponent, rival, season, state, questions
--     match_commit id, version, state, answers: stale unless version matches
--     match_settle id, finished, winner, ratings [{user, rating, season, result, abandoned}], rewards [{user, kind, payload}]
-- Returns one row of jsonb: what the operation has to say back.
create or replace function public.pvp_apply(p_payload text, p_signature text)
returns table (result jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_op jsonb;
  v_row public.pvp_queue;
  v_match public.pvp_matches;
  v_entry jsonb;
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

  case v_op ->> 'op'
    when 'consent' then
      insert into public.pvp_ratings (user_id, season, consented) values (v_user, v_op ->> 'season', true)
        on conflict (user_id) do update set consented = true;

    when 'season_close' then
      -- A new month: the rating carries halfway back, the record starts again, and last season's reward waits.
      update public.pvp_ratings r
         set rating = (v_op ->> 'rating')::integer, season = v_op ->> 'season', wins = 0, losses = 0, draws = 0, updated_at = now()
       where r.user_id = v_user and r.season <> v_op ->> 'season';
      if found and (v_op -> 'reward') is not null then
        insert into public.game_rewards (id, user_id, kind, payload) values (gen_random_uuid(), v_user, 'pvp_season', v_op -> 'reward');
      end if;

    when 'queue_join' then
      insert into public.pvp_queue as q (user_id, mode, rating, pool, target)
      values (v_user, v_op ->> 'mode', (v_op ->> 'rating')::integer, coalesce(v_op -> 'pool', '[]'::jsonb), (v_op ->> 'target')::uuid)
      on conflict (user_id) do update
        set mode = excluded.mode, rating = excluded.rating, pool = excluded.pool, target = excluded.target,
            joined_at = now(), claimed_by = null, claimed_at = null, match_id = null;

    when 'queue_leave' then
      delete from public.pvp_queue q where q.user_id = v_user;

    when 'claim' then
      select * into v_row
        from public.pvp_queue q
       where q.user_id <> v_user
         and q.match_id is null
         and (q.claimed_by is null or q.claimed_at < now() - interval '10 seconds')
         and q.joined_at > now() - interval '5 minutes'
         and not public.blocked_between(q.user_id, v_user)
         and case when v_op ->> 'mode' = 'friend'
                  then q.mode = 'friend' and q.target = v_user and q.user_id = (v_op ->> 'target')::uuid
                       and q.joined_at > now() - interval '60 seconds'
                  else q.mode = 'ranked' and abs(q.rating - (v_op ->> 'rating')::integer) <= (v_op ->> 'window')::integer
             end
       order by abs(q.rating - coalesce((v_op ->> 'rating')::integer, q.rating)), q.joined_at
       limit 1
       for update skip locked;
      if v_row.user_id is null then
        result := null;
        return next;
        return;
      end if;
      update public.pvp_queue q set claimed_by = v_user, claimed_at = now() where q.user_id = v_row.user_id;
      result := jsonb_build_object('user', v_row.user_id, 'rating', v_row.rating, 'pool', v_row.pool);
      return next;
      return;

    when 'match_create' then
      if (v_op ->> 'opponent') is not null and not exists (
        select 1 from public.pvp_queue q where q.user_id = (v_op ->> 'opponent')::uuid and q.claimed_by = v_user and q.match_id is null
      ) then
        raise exception 'that opponent was not claimed' using errcode = '22023';
      end if;
      insert into public.pvp_matches (id, mode, player_a, player_b, rival, season, state)
      values ((v_op ->> 'id')::uuid, v_op ->> 'mode', v_user, (v_op ->> 'opponent')::uuid, v_op -> 'rival', v_op ->> 'season', v_op -> 'state');
      insert into public.pvp_questions (match_id, idx, direction, prompt, options, sealed)
      select (v_op ->> 'id')::uuid, e.idx, e.direction, e.prompt, e.options, e.sealed
        from jsonb_to_recordset(coalesce(v_op -> 'questions', '[]'::jsonb))
          as e(idx smallint, direction text, prompt text, options jsonb, sealed text);
      delete from public.pvp_queue q where q.user_id = v_user;
      update public.pvp_queue q set match_id = (v_op ->> 'id')::uuid where q.user_id = (v_op ->> 'opponent')::uuid;

    when 'match_commit' then
      update public.pvp_matches m
         set state = v_op -> 'state', version = m.version + 1,
             finished_at = case when (v_op -> 'state' ->> 'finished')::boolean then coalesce(m.finished_at, now()) else m.finished_at end,
             winner = coalesce(m.winner, v_op -> 'state' ->> 'winner')
       where m.id = (v_op ->> 'id')::uuid and m.version = (v_op ->> 'version')::integer
         and v_user in (m.player_a, m.player_b)
      returning * into v_match;
      if v_match.id is null then
        result := jsonb_build_object('outcome', 'stale');
        return next;
        return;
      end if;
      insert into public.pvp_answers (match_id, side, idx, choice, correct, answered_at)
      select v_match.id, e.side, e.idx, e.choice, e.correct, coalesce(e.at, now())
        from jsonb_to_recordset(coalesce(v_op -> 'answers', '[]'::jsonb))
          as e(side text, idx smallint, choice smallint, correct boolean, at timestamptz)
      on conflict do nothing;
      delete from public.pvp_queue q where q.user_id = v_user and q.match_id = v_match.id;
      result := jsonb_build_object('outcome', 'ok', 'version', v_match.version);
      return next;
      return;

    when 'match_settle' then
      -- Once per match: ratings move and rewards wait only the first time.
      update public.pvp_matches m set settled = true
       where m.id = (v_op ->> 'id')::uuid and not m.settled and m.finished_at is not null
         and v_user in (m.player_a, m.player_b)
      returning * into v_match;
      if v_match.id is null then
        result := jsonb_build_object('outcome', 'already');
        return next;
        return;
      end if;
      for v_entry in select * from jsonb_array_elements(coalesce(v_op -> 'ratings', '[]'::jsonb)) loop
        if (v_entry ->> 'user')::uuid not in (v_match.player_a, coalesce(v_match.player_b, v_match.player_a)) then
          continue;
        end if;
        insert into public.pvp_ratings as r (user_id, rating, season, wins, losses, draws)
        values ((v_entry ->> 'user')::uuid, (v_entry ->> 'rating')::integer, v_entry ->> 'season',
                (v_entry ->> 'result' = 'won')::integer, (v_entry ->> 'result' = 'lost')::integer, (v_entry ->> 'result' = 'draw')::integer)
        on conflict (user_id) do update
          set rating = excluded.rating,
              season = excluded.season,
              wins = case when r.season = excluded.season then r.wins else 0 end + excluded.wins,
              losses = case when r.season = excluded.season then r.losses else 0 end + excluded.losses,
              draws = case when r.season = excluded.season then r.draws else 0 end + excluded.draws,
              abandons = case when (v_entry ->> 'abandoned')::boolean
                              then case when r.abandoned_on = current_date then r.abandons + 1 else 1 end
                              else r.abandons end,
              abandoned_on = case when (v_entry ->> 'abandoned')::boolean then current_date else r.abandoned_on end,
              -- Leaving three matches in a day locks matchmaking for five minutes.
              locked_until = case when (v_entry ->> 'abandoned')::boolean and r.abandoned_on = current_date and r.abandons + 1 >= 3
                                  then now() + interval '5 minutes' else r.locked_until end,
              updated_at = now();
      end loop;
      insert into public.game_rewards (id, user_id, kind, payload)
      select gen_random_uuid(), e."user", e.kind, coalesce(e.payload, '{}'::jsonb)
        from jsonb_to_recordset(coalesce(v_op -> 'rewards', '[]'::jsonb)) as e("user" uuid, kind text, payload jsonb)
       where e."user" in (v_match.player_a, coalesce(v_match.player_b, v_match.player_a))
         and e.kind in ('pvp', 'pvp_season');

    else
      raise exception 'unknown operation %', v_op ->> 'op' using errcode = '22023';
  end case;
  result := null;
  return next;
end;
$$;

revoke all on function public.pvp_apply(text, text) from anon, authenticated, public;
grant execute on function public.pvp_apply(text, text) to authenticated;

-- The API reads functions from a cache; it is told to read them again.
notify pgrst, 'reload schema';
