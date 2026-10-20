-- Schema version 19: Discovery & Input — where content is found, read,
-- heard and imported, and the one explicit act that turns a selection into
-- a saved word.
--
-- Two tables, all additive, none touching a word, its schedule or its
-- review history:
--
--   discovery_sources   one piece of content: pasted text, a reading, a
--                       listening source with its transcript, an import, a
--                       fetched page, a generated passage — with its
--                       provenance, its restorable position and nothing
--                       that could execute
--   discovery_marks     one selection of that source: its text, the
--                       sentence or cue around it, where it sat — still
--                       marked for later, or (by an explicit save) the
--                       word it became, kept apart by two nullable columns
--                       whose agreement a check insists on
--
-- What is NOT here is the point: no vocabulary is created by anything in
-- this file. `discovery_marks.vocabulary_id` is set only after the learner
-- pressed Save, through the ordinary word path; a mark for later references
-- nothing. Looking, listening, importing, generating and marking write only
-- these two tables — never `vocabulary`, `card_states` or `review_logs`.
-- Deleting a source takes its marks with it and leaves every word standing;
-- deleting a word keeps its marks' context (the link simply goes null).
--
-- Ownership and integrity are enforced the same way as the library and map
-- tables: composite foreign keys on (id, user_id), Row Level Security per
-- row owner, grants to `authenticated` only.
--
-- Additive only; run this file once, after the version 18 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 19 $$;

-- ---------------------------------------------------------------------------
-- The source itself
-- ---------------------------------------------------------------------------

create table public.discovery_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Where the content went: a quick paste, a reading, a listening source,
  -- model-generated, a file import, a fetched page, or the standing home
  -- of quick-capture marks. Provenance for the workspace that opens it.
  kind text not null
    check (kind in ('text', 'reading', 'listening', 'generated', 'imported', 'web', 'capture')),
  title text not null check (char_length(title) between 1 and 200 and title = btrim(title)),
  -- Where it came from: a URL, a file name, `typed`, `ai`. Never content.
  origin text not null default '' check (char_length(origin) <= 400),
  -- The content: plain text or a transcript. Never markup with anything in
  -- it — extraction strips to text before it reaches this column, so there
  -- is nothing here to execute and nothing for a browser to render as HTML.
  -- Bounded to a long reading, not a whole book: a source is an excerpt by
  -- construction.
  content text not null default '' check (char_length(content) <= 120000),
  content_kind text not null default 'plain' check (content_kind in ('plain', 'transcript')),
  -- Restorable position: a reading offset and/or a listening position in
  -- seconds. Last write wins; it carries nothing about learning.
  position jsonb not null default '{}'::jsonb check (jsonb_typeof(position) = 'object'),
  -- Bumped on title edits against a read revision; a position save moves
  -- the position and the timestamp, never the revision.
  revision integer not null default 1 check (revision >= 1),
  -- Identifies the submission that created the source, so a retry lands once.
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discovery_sources_id_user_key unique (id, user_id),
  constraint discovery_sources_request_key unique (user_id, request_id)
);

create index discovery_sources_user_idx on public.discovery_sources (user_id, updated_at desc);

create trigger discovery_sources_touch before update on public.discovery_sources
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Marks: a selection, its context, and — only by an explicit save — its word
-- ---------------------------------------------------------------------------

create table public.discovery_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_id uuid not null,
  -- The selection as it appeared: a word, a phrase, an idiom — its own
  -- text, never a vocabulary reference. A marked item is not a word.
  label text not null check (char_length(label) between 1 and 200 and label = btrim(label)),
  -- The sentence or cue around it: useful context, capped, never the source.
  context text not null default '' check (char_length(context) <= 2000),
  -- Reading/text: where the selection starts, in characters of the source.
  char_offset integer check (char_offset is null or (char_offset >= 0 and char_offset <= 120000)),
  -- Listening: the cue's window in milliseconds. Both or neither.
  cue_start integer check (cue_start is null or cue_start >= 0),
  cue_end integer check (cue_end is null or cue_end >= 0),
  -- The learner's own note on the selection.
  note text not null default '' check (char_length(note) <= 600),
  -- The word this mark became — set by an explicit save and by nothing
  -- else. When the word itself is gone the link goes null and the context
  -- of where it was found stays.
  vocabulary_id uuid references public.vocabulary (id) on delete set null,
  saved_at timestamptz,
  request_id uuid,
  created_at timestamptz not null default now(),
  constraint discovery_marks_id_user_key unique (id, user_id),
  constraint discovery_marks_request_key unique (user_id, request_id),
  constraint discovery_marks_source_fkey foreign key (source_id, user_id)
    references public.discovery_sources (id, user_id) on delete cascade,
  -- Saved means it has a word; marked means it does not. There is no state
  -- in which a row claims a word it was never saved to, and no path that
  -- moves one without the learner asking.
  constraint discovery_marks_saved_pair check ((saved_at is null) = (vocabulary_id is null)),
  constraint discovery_marks_cue_pair check ((cue_start is null) = (cue_end is null))
);

create index discovery_marks_source_idx on public.discovery_marks (source_id, created_at, id);
-- The back-link from a word to where it was found.
create index discovery_marks_vocabulary_idx on public.discovery_marks (vocabulary_id)
  where vocabulary_id is not null;
-- The same selection waits only once per source, however many times it is offered.
create unique index discovery_marks_label_idx on public.discovery_marks (source_id, label)
  where saved_at is null;

-- ---------------------------------------------------------------------------
-- Recording a title edit: one statement, so a revision is never lost
-- ---------------------------------------------------------------------------

-- Moves one source's revision on by one and returns the row as it now
-- stands. Row Level Security decides whether the caller has such a source:
-- one that is not theirs simply does not move, and nothing is returned.
create function public.bump_discovery_source_revision(p_source_id uuid)
returns public.discovery_sources
language sql
security invoker
set search_path = ''
as $$
  update public.discovery_sources
     set revision = revision + 1
   where id = p_source_id
  returning *;
$$;

revoke all on function public.bump_discovery_source_revision(uuid) from anon, authenticated, public;
grant execute on function public.bump_discovery_source_revision(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: every row is its owner's and nobody else's
-- ---------------------------------------------------------------------------

alter table public.discovery_sources enable row level security;
alter table public.discovery_marks enable row level security;

create policy discovery_sources_select on public.discovery_sources for select to authenticated
  using (user_id = (select auth.uid()));
create policy discovery_sources_insert on public.discovery_sources for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy discovery_sources_update on public.discovery_sources for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy discovery_sources_delete on public.discovery_sources for delete to authenticated
  using (user_id = (select auth.uid()));

create policy discovery_marks_select on public.discovery_marks for select to authenticated
  using (user_id = (select auth.uid()));
create policy discovery_marks_insert on public.discovery_marks for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy discovery_marks_update on public.discovery_marks for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy discovery_marks_delete on public.discovery_marks for delete to authenticated
  using (user_id = (select auth.uid()));

-- Privileges: start from nothing, then grant exactly what the policies above cover.
revoke all on public.discovery_sources, public.discovery_marks
  from anon, authenticated, public;
grant select, insert, update, delete on public.discovery_sources to authenticated;
grant select, insert, update, delete on public.discovery_marks to authenticated;
