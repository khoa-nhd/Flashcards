-- Schema version 11: vocabulary analysis for Vocabulary Expert.
--
-- Stores the full structured analysis from Vocabulary Expert for a word.
-- One analysis per vocabulary entry, linked by vocabulary_id.

-- ---------------------------------------------------------------------------
-- Schema version marker
-- ---------------------------------------------------------------------------

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 11 $$;

revoke all on function public.app_schema_version() from anon, authenticated, public;
grant execute on function public.app_schema_version() to authenticated;

-- ---------------------------------------------------------------------------
-- Table: vocabulary_analysis
-- ---------------------------------------------------------------------------

create table public.vocabulary_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  vocabulary_id uuid not null,
  -- Core analysis fields from Vocabulary Expert
  pronunciation text,
  part_of_speech text,
  cefr_level text,
  confidence numeric(3,2),
  -- Definitions and translations
  english_definition text,
  vietnamese_meaning text,
  -- Multiple senses
  senses jsonb not null default '[]'::jsonb,
  -- Examples
  examples jsonb not null default '[]'::jsonb,
  -- Word family and derivatives
  word_family jsonb not null default '[]'::jsonb,
  -- Collocations
  collocations jsonb not null default '[]'::jsonb,
  -- Synonyms and antonyms with nuance
  synonyms jsonb not null default '[]'::jsonb,
  antonyms jsonb not null default '[]'::jsonb,
  -- Usage notes and common mistakes
  usage_notes text,
  common_mistakes text,
  -- Revision summary
  revision_summary text,
  -- Model metadata
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vocabulary_analysis_vocabulary_fkey foreign key (vocabulary_id, user_id)
    references public.vocabulary (id, user_id) on delete cascade,
  constraint vocabulary_analysis_user_vocabulary_key unique (user_id, vocabulary_id)
);

create index vocabulary_analysis_user_idx on public.vocabulary_analysis (user_id);

alter table public.vocabulary_analysis enable row level security;

create policy vocabulary_analysis_select on public.vocabulary_analysis for select to authenticated
  using (user_id = (select auth.uid()));
create policy vocabulary_analysis_insert on public.vocabulary_analysis for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy vocabulary_analysis_update on public.vocabulary_analysis for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy vocabulary_analysis_delete on public.vocabulary_analysis for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.vocabulary_analysis from anon, authenticated, public;
grant select, insert, update, delete on public.vocabulary_analysis to authenticated;

-- ---------------------------------------------------------------------------
-- Updated_at trigger
-- ---------------------------------------------------------------------------

create trigger vocabulary_analysis_touch before update on public.vocabulary_analysis
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Functions for server-side use (security invoker = runs as caller)
-- ---------------------------------------------------------------------------

-- Creates or updates the analysis for a vocabulary entry.
-- Returns the analysis row.
create function public.upsert_vocabulary_analysis(
  p_vocabulary_id uuid,
  p_pronunciation text default null,
  p_part_of_speech text default null,
  p_cefr_level text default null,
  p_confidence numeric default null,
  p_english_definition text default null,
  p_vietnamese_meaning text default null,
  p_senses jsonb default '[]'::jsonb,
  p_examples jsonb default '[]'::jsonb,
  p_word_family jsonb default '[]'::jsonb,
  p_collocations jsonb default '[]'::jsonb,
  p_synonyms jsonb default '[]'::jsonb,
  p_antonyms jsonb default '[]'::jsonb,
  p_usage_notes text default null,
  p_common_mistakes text default null,
  p_revision_summary text default null,
  p_model text default null
)
returns table (
  id uuid,
  vocabulary_id uuid,
  pronunciation text,
  part_of_speech text,
  cefr_level text,
  confidence numeric,
  english_definition text,
  vietnamese_meaning text,
  senses jsonb,
  examples jsonb,
  word_family jsonb,
  collocations jsonb,
  synonyms jsonb,
  antonyms jsonb,
  usage_notes text,
  common_mistakes text,
  revision_summary text,
  model text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
-- The RETURNS TABLE columns (id, vocabulary_id, ...) share names with the
-- table's own columns, so prefer the column when a name is ambiguous.
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Verify the vocabulary belongs to the user
  if not exists (
    select 1 from public.vocabulary v
    where v.id = p_vocabulary_id and v.user_id = v_user and v.deleted_at is null
  ) then
    raise exception 'vocabulary not found' using errcode = '42501';
  end if;

  return query
  insert into public.vocabulary_analysis as va (
    user_id, vocabulary_id,
    pronunciation, part_of_speech, cefr_level, confidence,
    english_definition, vietnamese_meaning,
    senses, examples, word_family, collocations, synonyms, antonyms,
    usage_notes, common_mistakes, revision_summary, model
  ) values (
    v_user, p_vocabulary_id,
    p_pronunciation, p_part_of_speech, p_cefr_level, p_confidence,
    p_english_definition, p_vietnamese_meaning,
    p_senses, p_examples, p_word_family, p_collocations, p_synonyms, p_antonyms,
    p_usage_notes, p_common_mistakes, p_revision_summary, p_model
  )
  on conflict (user_id, vocabulary_id) do update set
    pronunciation = excluded.pronunciation,
    part_of_speech = excluded.part_of_speech,
    cefr_level = excluded.cefr_level,
    confidence = excluded.confidence,
    english_definition = excluded.english_definition,
    vietnamese_meaning = excluded.vietnamese_meaning,
    senses = excluded.senses,
    examples = excluded.examples,
    word_family = excluded.word_family,
    collocations = excluded.collocations,
    synonyms = excluded.synonyms,
    antonyms = excluded.antonyms,
    usage_notes = excluded.usage_notes,
    common_mistakes = excluded.common_mistakes,
    revision_summary = excluded.revision_summary,
    model = excluded.model,
    updated_at = now()
  returning
    va.id, va.vocabulary_id, va.pronunciation, va.part_of_speech, va.cefr_level,
    va.confidence, va.english_definition, va.vietnamese_meaning, va.senses,
    va.examples, va.word_family, va.collocations, va.synonyms, va.antonyms,
    va.usage_notes, va.common_mistakes, va.revision_summary, va.model,
    va.created_at, va.updated_at;
end;
$$;

revoke all on function public.upsert_vocabulary_analysis(
  uuid, text, text, text, numeric, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb,
  text, text, text, text
) from anon, authenticated, public;
grant execute on function public.upsert_vocabulary_analysis(
  uuid, text, text, text, numeric, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb,
  text, text, text, text
) to authenticated;

-- Gets the analysis for a vocabulary entry, or null if none exists.
create function public.get_vocabulary_analysis(p_vocabulary_id uuid)
returns table (
  id uuid,
  vocabulary_id uuid,
  pronunciation text,
  part_of_speech text,
  cefr_level text,
  confidence numeric,
  english_definition text,
  vietnamese_meaning text,
  senses jsonb,
  examples jsonb,
  word_family jsonb,
  collocations jsonb,
  synonyms jsonb,
  antonyms jsonb,
  usage_notes text,
  common_mistakes text,
  revision_summary text,
  model text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    id, vocabulary_id, pronunciation, part_of_speech, cefr_level, confidence,
    english_definition, vietnamese_meaning, senses, examples, word_family,
    collocations, synonyms, antonyms, usage_notes, common_mistakes,
    revision_summary, model, created_at, updated_at
  from public.vocabulary_analysis
  where vocabulary_id = p_vocabulary_id and user_id = (select auth.uid());
$$;

revoke all on function public.get_vocabulary_analysis(uuid) from anon, authenticated, public;
grant execute on function public.get_vocabulary_analysis(uuid) to authenticated;

-- Deletes the analysis for a vocabulary entry.
create function public.delete_vocabulary_analysis(p_vocabulary_id uuid)
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
  delete from public.vocabulary_analysis
  where vocabulary_id = p_vocabulary_id and user_id = v_user;
  return found;
end;
$$;

revoke all on function public.delete_vocabulary_analysis(uuid) from anon, authenticated, public;
grant execute on function public.delete_vocabulary_analysis(uuid) to authenticated;