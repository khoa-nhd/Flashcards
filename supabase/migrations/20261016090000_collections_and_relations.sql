-- Schema version 7: collections, more examples, and relationships between words.
--
-- Three ways of organising vocabulary. None of them touches a word's content,
-- its schedule or its review history:
--
--   collections           named groups; a word can be in several
--   vocabulary_examples   further example sentences for a word, with a source note
--   vocabulary_relations  typed links between two words, entered by their owner
--
-- These rows are housekeeping, not learning history, so unlike words and
-- reviews they can be deleted outright. Deleting a collection removes the
-- collection and its memberships and nothing else: no word is ever deleted by
-- anything in this file.
--
-- Additive only; run this file once, after the version 6 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 7 $$;

-- ---------------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------------

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  -- The name as compared for uniqueness: case and spacing ignored. Computed by the app.
  name_key text not null check (char_length(name_key) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collections_id_user_key unique (id, user_id),
  constraint collections_name_key unique (user_id, name_key)
);

create trigger collections_touch before update on public.collections
  for each row execute function public.touch_updated_at();

-- Which words are in which collection. Both ends must belong to the same
-- user as the row, so a collection can never hold someone else's word.
create table public.collection_items (
  collection_id uuid not null,
  vocabulary_id uuid not null,
  user_id uuid not null default auth.uid(),
  added_at timestamptz not null default now(),
  primary key (collection_id, vocabulary_id),
  constraint collection_items_collection_fkey foreign key (collection_id, user_id)
    references public.collections (id, user_id) on delete cascade,
  constraint collection_items_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade
);

create index collection_items_vocabulary_idx on public.collection_items (vocabulary_id);
create index collection_items_user_idx on public.collection_items (user_id);

-- ---------------------------------------------------------------------------
-- Further examples
-- ---------------------------------------------------------------------------

-- A word keeps its original example on the word itself, where the flashcard
-- reads it. These are additional sentences, each with an optional note of
-- where it came from. At most one per word is marked as the preferred one.
create table public.vocabulary_examples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  vocabulary_id uuid not null,
  sentence text not null check (char_length(sentence) between 1 and 2000),
  source text check (source is null or char_length(source) between 1 and 300),
  preferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vocabulary_examples_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade
);

create index vocabulary_examples_vocabulary_idx on public.vocabulary_examples (vocabulary_id, created_at);
create index vocabulary_examples_user_idx on public.vocabulary_examples (user_id);
create unique index vocabulary_examples_one_preferred_idx on public.vocabulary_examples (vocabulary_id)
  where preferred;

create trigger vocabulary_examples_touch before update on public.vocabulary_examples
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Relationships between words
-- ---------------------------------------------------------------------------

-- Every kind of relationship here reads the same in both directions ("A is a
-- synonym of B" says the same as "B is a synonym of A"), so a pair is stored
-- once, with the smaller id first. That makes a duplicate and its reverse the
-- same row, which the unique constraint then refuses.
create table public.vocabulary_relations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  low_id uuid not null,
  high_id uuid not null,
  kind text not null
    check (kind in ('synonym', 'antonym', 'word_family', 'collocation', 'related', 'confused')),
  created_at timestamptz not null default now(),
  constraint vocabulary_relations_order check (low_id < high_id),
  constraint vocabulary_relations_pair_key unique (user_id, low_id, high_id, kind),
  constraint vocabulary_relations_low_fkey foreign key (low_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade,
  constraint vocabulary_relations_high_fkey foreign key (high_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade
);

create index vocabulary_relations_high_idx on public.vocabulary_relations (high_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: every row is its owner's and nobody else's
-- ---------------------------------------------------------------------------

alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
alter table public.vocabulary_examples enable row level security;
alter table public.vocabulary_relations enable row level security;

create policy collections_select on public.collections for select to authenticated
  using (user_id = (select auth.uid()));
create policy collections_insert on public.collections for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy collections_update on public.collections for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy collections_delete on public.collections for delete to authenticated
  using (user_id = (select auth.uid()));

create policy collection_items_select on public.collection_items for select to authenticated
  using (user_id = (select auth.uid()));
create policy collection_items_insert on public.collection_items for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy collection_items_delete on public.collection_items for delete to authenticated
  using (user_id = (select auth.uid()));

create policy vocabulary_examples_select on public.vocabulary_examples for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_examples_insert on public.vocabulary_examples for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_examples_update on public.vocabulary_examples for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vocabulary_examples_delete on public.vocabulary_examples for delete to authenticated
  using (user_id = (select auth.uid()));

create policy vocabulary_relations_select on public.vocabulary_relations for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_relations_insert on public.vocabulary_relations for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_relations_delete on public.vocabulary_relations for delete to authenticated
  using (user_id = (select auth.uid()));

-- Privileges: start from nothing, then grant exactly what the policies above cover.
revoke all on public.collections, public.collection_items, public.vocabulary_examples, public.vocabulary_relations
  from anon, authenticated, public;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, delete on public.collection_items to authenticated;
grant select, insert, update, delete on public.vocabulary_examples to authenticated;
grant select, insert, delete on public.vocabulary_relations to authenticated;

-- ---------------------------------------------------------------------------
-- Marking the preferred example
-- ---------------------------------------------------------------------------

-- Makes one example the preferred one for its word and clears the mark from
-- the word's other examples, in one transaction. With `p_preferred` false it
-- only clears the mark from this example. Returns whether the example exists.
create function public.set_preferred_example(p_example_id uuid, p_preferred boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_vocabulary uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select e.vocabulary_id into v_vocabulary from public.vocabulary_examples e
   where e.id = p_example_id and e.user_id = v_user;
  if not found then
    return false;
  end if;
  -- Clear first, so the one-preferred-per-word index is never violated on the way.
  update public.vocabulary_examples e set preferred = false
   where e.vocabulary_id = v_vocabulary and e.user_id = v_user and e.preferred and e.id <> p_example_id;
  update public.vocabulary_examples e set preferred = coalesce(p_preferred, false)
   where e.id = p_example_id and e.user_id = v_user;
  return true;
end;
$$;

revoke all on function public.set_preferred_example(uuid, boolean) from anon, authenticated, public;
grant execute on function public.set_preferred_example(uuid, boolean) to authenticated;
