-- Schema version 22: loot chests.
--
-- One row of state per account (keys, shards, pity, opens), one row per
-- collectible owned, and one row per opening for the audit trail and for
-- idempotency: the same request id can never open two chests.
--
-- The rolls themselves happen in the server, which then commits the whole
-- opening through apply_gacha_open() in one transaction. Run once, after
-- version 21. Every statement can be run again if the SQL Editor stops partway.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 22 $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.gacha_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  keys integer not null default 0 check (keys between 0 and 99),
  shards integer not null default 0 check (shards >= 0 and shards <= 1000000),
  -- Openings since the last epic-or-better, and since the last legendary.
  since_epic integer not null default 0 check (since_epic >= 0),
  since_legendary integer not null default 0 check (since_legendary >= 0),
  -- Every opening ever, used to notice two openings racing each other.
  opens integer not null default 0 check (opens >= 0),
  last_grant_day date,
  updated_at timestamptz not null default now()
);

create table if not exists public.gacha_inventory (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null check (char_length(item_id) between 1 and 64),
  rarity text not null check (rarity in ('common', 'rare', 'epic', 'legendary')),
  quantity integer not null default 1 check (quantity between 1 and 1000000),
  first_obtained_at timestamptz not null default now(),
  last_obtained_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.gacha_opens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null,
  chest_id text not null,
  count integer not null check (count between 0 and 10),
  results jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, request_id)
);

alter table public.gacha_state enable row level security;
alter table public.gacha_inventory enable row level security;
alter table public.gacha_opens enable row level security;

drop policy if exists gacha_state_select on public.gacha_state;
create policy gacha_state_select on public.gacha_state for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists gacha_state_insert on public.gacha_state;
create policy gacha_state_insert on public.gacha_state for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists gacha_state_update on public.gacha_state;
create policy gacha_state_update on public.gacha_state for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists gacha_inventory_select on public.gacha_inventory;
create policy gacha_inventory_select on public.gacha_inventory for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists gacha_inventory_insert on public.gacha_inventory;
create policy gacha_inventory_insert on public.gacha_inventory for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists gacha_inventory_update on public.gacha_inventory;
create policy gacha_inventory_update on public.gacha_inventory for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- The record of openings is append-only: it is what a retried request reads.
drop policy if exists gacha_opens_select on public.gacha_opens;
create policy gacha_opens_select on public.gacha_opens for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists gacha_opens_insert on public.gacha_opens;
create policy gacha_opens_insert on public.gacha_opens for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on public.gacha_state from anon, authenticated, public;
revoke all on public.gacha_inventory from anon, authenticated, public;
revoke all on public.gacha_opens from anon, authenticated, public;

grant select, insert, update on public.gacha_state to authenticated;
grant select, insert, update on public.gacha_inventory to authenticated;
grant select, insert on public.gacha_opens to authenticated;

-- ---------------------------------------------------------------------------
-- One opening, committed whole
-- ---------------------------------------------------------------------------

-- Writes the state, the inventory gained and the opening record together, and
-- answers "replayed" when this request id was already committed: a double
-- click or a retried request cannot open (or pay for) a second chest.
create or replace function public.apply_gacha_open(
  p_expected_opens integer,
  p_keys integer,
  p_shards integer,
  p_since_epic integer,
  p_since_legendary integer,
  p_opens integer,
  p_last_grant_day date,
  p_items jsonb,
  p_request_id uuid,
  p_chest_id text,
  p_count integer,
  p_results jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_current integer;
  v_existing jsonb;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if p_request_id is not null then
    select results into v_existing
      from public.gacha_opens
     where user_id = v_user and request_id = p_request_id;
    if found then
      return jsonb_build_object('outcome', 'replayed', 'results', v_existing);
    end if;
  end if;

  -- Locked, so two openings cannot both read the same balance.
  select opens into v_current from public.gacha_state where user_id = v_user for update;
  if coalesce(v_current, 0) <> p_expected_opens then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  insert into public.gacha_state (user_id, keys, shards, since_epic, since_legendary, opens, last_grant_day)
  values (v_user, p_keys, p_shards, p_since_epic, p_since_legendary, p_opens, p_last_grant_day)
  on conflict (user_id) do update set
    keys = excluded.keys,
    shards = excluded.shards,
    since_epic = excluded.since_epic,
    since_legendary = excluded.since_legendary,
    opens = excluded.opens,
    last_grant_day = excluded.last_grant_day,
    updated_at = now();

  if coalesce(jsonb_array_length(p_items), 0) > 0 then
    insert into public.gacha_inventory (user_id, item_id, rarity, quantity)
    select v_user, item.item_id, item.rarity, item.quantity
      from jsonb_to_recordset(p_items) as item(item_id text, rarity text, quantity integer)
    on conflict (user_id, item_id) do update set
      quantity = public.gacha_inventory.quantity + excluded.quantity,
      rarity = excluded.rarity,
      last_obtained_at = now();
  end if;

  if p_request_id is not null then
    insert into public.gacha_opens (user_id, request_id, chest_id, count, results)
    values (v_user, p_request_id, p_chest_id, p_count, coalesce(p_results, '[]'::jsonb));
  end if;

  return jsonb_build_object('outcome', 'applied');
end;
$$;

revoke all on function public.apply_gacha_open(
  integer, integer, integer, integer, integer, integer, date, jsonb, uuid, text, integer, jsonb
) from anon, authenticated, public;
grant execute on function public.apply_gacha_open(
  integer, integer, integer, integer, integer, integer, date, jsonb, uuid, text, integer, jsonb
) to authenticated;
