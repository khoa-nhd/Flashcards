-- Schema version 18: vocabulary maps — the diagrams a learner draws with
-- their own words.
--
-- Three tables, all additive, none touching a word, its schedule or its
-- review history:
--
--   vocabulary_maps        one diagram: a type, a title, an edit revision
--   vocabulary_map_nodes   what sits on it — a saved word by canonical id
--                          (optionally one particular sense of it), or an
--                          unsaved candidate the AI or the learner suggested
--   vocabulary_map_edges   typed relationships between two nodes of the
--                          same map, with the combination or difference text
--
-- What is NOT here is the point: no vocabulary is ever created by anything
-- in this file. A candidate node references no word; it becomes one only
-- when the learner explicitly saves it through the ordinary word path.
-- Saving a map, opening a map, expanding a map with AI — none of those write
-- to `vocabulary`, `card_states` or `review_logs`.
--
-- Ownership and integrity are enforced by the database, the same way the
-- library tables do it: composite foreign keys on (id, user_id) mean a map
-- can never hold a word, a sense or an endpoint from another account, and
-- Row Level Security means no query can even see another account's maps.
--
-- Additive only; run this file once, after the version 17 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 18 $$;

-- ---------------------------------------------------------------------------
-- One unambiguous target for a sense's composite foreign key
-- ---------------------------------------------------------------------------

-- vocabulary_senses is keyed by id alone; the map tables need a sense's
-- (id, vocabulary_id, user_id) triple to be unique so a node can promise, in
-- one foreign key, that a sense belongs to the very word the node names and
-- to the same account. Existing rows already satisfy it: id is the primary
-- key, so the triple is unique by construction.
alter table public.vocabulary_senses
  add constraint vocabulary_senses_triple_key unique (id, vocabulary_id, user_id);

-- ---------------------------------------------------------------------------
-- The map itself
-- ---------------------------------------------------------------------------

create table public.vocabulary_maps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null
    check (type in ('semantic', 'word_family', 'collocation', 'thematic', 'nuance', 'scenario', 'function')),
  title text not null check (char_length(title) between 1 and 120 and title = btrim(title)),
  description text not null default '' check (char_length(description) <= 600),
  -- Bumped by the app on every structural change; a stale edit is refused
  -- against this rather than silently overwriting a fresher one.
  revision integer not null default 1 check (revision >= 1),
  -- Identifies the submission that created the map, so a retry lands once.
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vocabulary_maps_id_user_key unique (id, user_id),
  constraint vocabulary_maps_request_key unique (user_id, request_id)
);

create index vocabulary_maps_user_idx on public.vocabulary_maps (user_id, updated_at desc);

create trigger vocabulary_maps_touch before update on public.vocabulary_maps
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Nodes: saved vocabulary by id, or unsaved candidates by label
-- ---------------------------------------------------------------------------

-- One node is either a saved word (canonical id, optionally one particular
-- sense of it) or a candidate (a label, referencing nothing). The checks hold
-- that line exactly: a candidate can never smuggle a vocabulary reference,
-- and a saved node can never drift into free text — its label is read from
-- the word itself, live, so renaming a word updates every map at once.
create table public.vocabulary_map_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  map_id uuid not null,
  kind text not null check (kind in ('saved', 'candidate')),
  vocabulary_id uuid,
  sense_id uuid,
  -- Candidates only: the suggested word itself.
  label text
    check (label is null or (char_length(label) between 1 and 80 and label = btrim(label))),
  note text not null default '' check (char_length(note) <= 600),
  -- A topic, subtopic or communicative intention the node sits under.
  group_key text
    check (group_key is null or (char_length(group_key) between 1 and 60 and group_key = btrim(group_key))),
  -- Scenario maps: which step of the situation this node belongs to.
  step integer check (step is null or (step between 1 and 999)),
  -- Saved layout, in the canvas' own coordinates; null until the learner moves it.
  x integer check (x is null or (x between -2000 and 2000)),
  y integer check (y is null or (y between -2000 and 2000)),
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint vocabulary_map_nodes_map_fkey foreign key (map_id, user_id)
    references public.vocabulary_maps (id, user_id) on delete cascade,
  -- The word must be live and the caller's own. Deleting a word removes its
  -- nodes from every map; deleting a map removes nothing from the vocabulary.
  constraint vocabulary_map_nodes_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade,
  -- A sense node promises, in one key, that the sense belongs to the very
  -- word the node names and to the same account.
  constraint vocabulary_map_nodes_sense_fkey foreign key (sense_id, vocabulary_id, user_id)
    references public.vocabulary_senses (id, vocabulary_id, user_id) on delete cascade,
  constraint vocabulary_map_nodes_saved check (
    kind <> 'saved' or (vocabulary_id is not null and label is null)
  ),
  constraint vocabulary_map_nodes_candidate check (
    kind <> 'candidate' or (vocabulary_id is null and label is not null)
  ),
  constraint vocabulary_map_nodes_sense_with_word check (
    sense_id is null or vocabulary_id is not null
  ),
  constraint vocabulary_map_nodes_id_user_key unique (id, user_id),
  constraint vocabulary_map_nodes_request_key unique (map_id, request_id)
);

create index vocabulary_map_nodes_map_idx on public.vocabulary_map_nodes (map_id, created_at, id);

-- No word twice on one map: the same word at the same sense is one node, and
-- a word with no sense chosen is one word-level node. (Several senses of one
-- word may sit on the map as several nodes — that is the point of senses.)
create unique index vocabulary_map_nodes_word_level_idx on public.vocabulary_map_nodes (map_id, vocabulary_id)
  where kind = 'saved' and sense_id is null;
create unique index vocabulary_map_nodes_sense_level_idx on public.vocabulary_map_nodes (map_id, vocabulary_id, sense_id)
  where kind = 'saved' and sense_id is not null;
-- A candidate is identified by its text within the map, so the same
-- suggestion never appears twice however many times it is offered.
create unique index vocabulary_map_nodes_candidate_idx on public.vocabulary_map_nodes (map_id, label)
  where kind = 'candidate';

-- ---------------------------------------------------------------------------
-- Edges: typed relationships between two nodes of the same map
-- ---------------------------------------------------------------------------

-- The kind fixes how the edge reads; which kinds a map accepts is the map
-- type's business, checked by the service against the same list the browser
-- uses. The direction is storage only — "A hypernym of B" reads from A to B —
-- and both endpoints must be nodes of this very map, which the two composite
-- keys promise along with ownership.
create table public.vocabulary_map_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  map_id uuid not null,
  from_node_id uuid not null,
  to_node_id uuid not null,
  kind text not null
    check (kind in (
      'synonym', 'antonym', 'hypernym', 'hyponym', 'related', 'confused',
      'inflection', 'derivation', 'related_form',
      'verb_noun', 'adjective_noun', 'adverb_adjective', 'collocation', 'other_pattern',
      'contrast', 'subtopic', 'step', 'phrase_variant'
    )),
  -- The combination text for a collocation pattern ("make a decision").
  pattern text not null default '' check (char_length(pattern) <= 120),
  -- The difference a contrast draws, or a note on the link.
  note text not null default '' check (char_length(note) <= 600),
  created_at timestamptz not null default now(),
  constraint vocabulary_map_edges_map_fkey foreign key (map_id, user_id)
    references public.vocabulary_maps (id, user_id) on delete cascade,
  constraint vocabulary_map_edges_from_fkey foreign key (from_node_id, user_id)
    references public.vocabulary_map_nodes (id, user_id) on delete cascade,
  constraint vocabulary_map_edges_to_fkey foreign key (to_node_id, user_id)
    references public.vocabulary_map_nodes (id, user_id) on delete cascade,
  constraint vocabulary_map_edges_not_self check (from_node_id <> to_node_id),
  -- Drawing the same link twice is the same link, not a second one.
  constraint vocabulary_map_edges_pair_key unique (map_id, from_node_id, to_node_id, kind)
);

create index vocabulary_map_edges_map_idx on public.vocabulary_map_edges (map_id, created_at, id);
create index vocabulary_map_edges_from_idx on public.vocabulary_map_edges (from_node_id);
create index vocabulary_map_edges_to_idx on public.vocabulary_map_edges (to_node_id);

-- ---------------------------------------------------------------------------
-- Recording an edit: one statement, so a revision is never lost
-- ---------------------------------------------------------------------------

-- Moves one map's revision on by one and returns the row as it now stands.
-- Row Level Security decides, as ever, whether the caller has such a map: a
-- map that is not theirs simply does not move, and nothing is returned.
create function public.bump_vocabulary_map_revision(p_map_id uuid)
returns public.vocabulary_maps
language sql
security invoker
set search_path = ''
as $$
  update public.vocabulary_maps
     set revision = revision + 1
   where id = p_map_id
  returning *;
$$;

revoke all on function public.bump_vocabulary_map_revision(uuid) from anon, authenticated, public;
grant execute on function public.bump_vocabulary_map_revision(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: every row is its owner's and nobody else's
-- ---------------------------------------------------------------------------

alter table public.vocabulary_maps enable row level security;
alter table public.vocabulary_map_nodes enable row level security;
alter table public.vocabulary_map_edges enable row level security;

create policy vocabulary_maps_select on public.vocabulary_maps for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_maps_insert on public.vocabulary_maps for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_maps_update on public.vocabulary_maps for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vocabulary_maps_delete on public.vocabulary_maps for delete to authenticated
  using (user_id = (select auth.uid()));

create policy vocabulary_map_nodes_select on public.vocabulary_map_nodes for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_map_nodes_insert on public.vocabulary_map_nodes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_map_nodes_update on public.vocabulary_map_nodes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vocabulary_map_nodes_delete on public.vocabulary_map_nodes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy vocabulary_map_edges_select on public.vocabulary_map_edges for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_map_edges_insert on public.vocabulary_map_edges for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_map_edges_update on public.vocabulary_map_edges for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vocabulary_map_edges_delete on public.vocabulary_map_edges for delete to authenticated
  using (user_id = (select auth.uid()));

-- Privileges: start from nothing, then grant exactly what the policies above cover.
revoke all on public.vocabulary_maps, public.vocabulary_map_nodes, public.vocabulary_map_edges
  from anon, authenticated, public;
grant select, insert, update, delete on public.vocabulary_maps to authenticated;
grant select, insert, update, delete on public.vocabulary_map_nodes to authenticated;
grant select, insert, update, delete on public.vocabulary_map_edges to authenticated;
