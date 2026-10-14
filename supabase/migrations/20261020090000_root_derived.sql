-- Schema version 11: root → derived.
--
-- Which word a word was formed from ("decision" from "decide") is a
-- direction, not a flat link: the derived word points at its root and the
-- root points at nothing. A relation row between two words cannot say this,
-- because it does not know which end is the base. This adds one nullable
-- column and an index; nothing is backfilled, and a word without a root is
-- exactly as it was. It never touches a word's content, mastery, review date
-- or FSRS state.
--
-- Additive only; run this file once, after the version 10 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 11 $$;

-- ---------------------------------------------------------------------------
-- The word this one was formed from
-- ---------------------------------------------------------------------------

alter table public.vocabulary
  add column root_id uuid;

-- A single-column foreign key on purpose: a composite (root_id, user_id) key
-- with ON DELETE SET NULL would null user_id too and break the derived
-- word's row. Words are only ever trashed, never deleted, so the pointer
-- normally lives until the account itself goes; ownership of it is enforced
-- where it is written, below, and reads are the table's own row level
-- security.
alter table public.vocabulary
  add constraint vocabulary_root_id_fkey
  foreign key (root_id) references public.vocabulary (id) on delete set null;

alter table public.vocabulary
  add constraint vocabulary_root_id_not_self
    check (root_id is null or root_id <> id);

create index vocabulary_root_id_idx on public.vocabulary (root_id)
  where root_id is not null;

-- The card view with the new column appended. A view may only gain columns
-- at the end, so every column above keeps its name, type and place.
create or replace view public.vocabulary_cards with (security_invoker = true) as
select
  v.id,
  v.user_id,
  v.word,
  v.word_key,
  v.meaning,
  v.definition,
  v.example,
  v.date_added,
  v.created_at,
  greatest(v.updated_at, c.updated_at) as updated_at,
  v.deleted_at,
  c.mastery,
  c.review_date,
  c.fsrs_due,
  c.fsrs_stability,
  c.fsrs_difficulty,
  c.fsrs_last_review,
  c.fsrs_reps,
  c.fsrs_lapses,
  c.fsrs_state,
  c.fsrs_scheduled_days,
  c.fsrs_learning_steps,
  c.fsrs_version,
  v.root_id
from public.vocabulary v
join public.card_states c on c.vocabulary_id = v.id and c.user_id = v.user_id;

-- update_vocabulary: the same function with root_id among the fields it
-- manages,
--
--   { ..., "root_id": "<uuid>" | null }
--
-- read only when present, with a JSON null clearing the pointer, exactly as
-- the other fields behave. The root must be a word of the caller's own
-- account: row level security hides every other row, so this exists() is
-- both an existence and an ownership check.
create or replace function public.update_vocabulary(p_id uuid, p_patch jsonb) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
  v_text_changed boolean := false;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('word', 'word_key', 'meaning', 'definition', 'example', 'date_added', 'mastery', 'review_date', 'root_id') then
      raise exception 'unknown field: %', v_key using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'root_id' and p_patch ->> 'root_id' is not null then
    if not exists (select 1 from public.vocabulary v
                    where v.id = (p_patch ->> 'root_id')::uuid and v.user_id = v_user) then
      raise exception 'root word not found' using errcode = 'P0002';
    end if;
  end if;

  if p_patch ?| array['word', 'word_key', 'meaning', 'definition', 'example', 'date_added', 'root_id'] then
    update public.vocabulary v set
      word = case when p_patch ? 'word' then p_patch ->> 'word' else v.word end,
      word_key = case when p_patch ? 'word_key' then p_patch ->> 'word_key' else v.word_key end,
      meaning = case when p_patch ? 'meaning' then p_patch ->> 'meaning' else v.meaning end,
      definition = case when p_patch ? 'definition' then p_patch ->> 'definition' else v.definition end,
      example = case when p_patch ? 'example' then p_patch ->> 'example' else v.example end,
      date_added = case when p_patch ? 'date_added' then (p_patch ->> 'date_added')::date else v.date_added end,
      root_id = case when p_patch ? 'root_id' then (p_patch ->> 'root_id')::uuid else v.root_id end
    where v.id = p_id and v.user_id = v_user and v.deleted_at is null;
    if not found then
      return false;
    end if;
    v_text_changed := true;
  end if;

  if p_patch ?| array['mastery', 'review_date'] then
    update public.card_states c set
      mastery = case when p_patch ? 'mastery' then (p_patch ->> 'mastery')::smallint else c.mastery end,
      review_date = case when p_patch ? 'review_date' then (p_patch ->> 'review_date')::date else c.review_date end
    where c.vocabulary_id = p_id and c.user_id = v_user
      and exists (select 1 from public.vocabulary v where v.id = p_id and v.user_id = v_user and v.deleted_at is null);
    if not found then
      if v_text_changed then
        -- Raising, not returning, so the change above is rolled back too.
        raise exception 'scheduling state is missing for this word' using errcode = 'P0002';
      end if;
      return false;
    end if;
  end if;

  return true;
end;
$$;
