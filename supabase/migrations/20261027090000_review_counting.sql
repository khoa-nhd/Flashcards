-- Schema version 13: whether a review counts towards mastery.
--
-- The owner's rule (2026-10-17): whether a review moves a word is the
-- reviewer's own choice, asked for beside the words being reviewed, and it is
-- remembered for next time. Until now the only answer that left a word alone
-- was one taken from the weakest-words review, which was hard-wired to do so.
--
-- The answer itself does not change: it is still recorded, still counted in
-- accuracy, streaks and the daily goal, and can still be taken back with Undo.
-- Only mastery, the review date and the FSRS state stay where they were.
--
-- Additive only; run this file once, after the version 12 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 13 $$;

-- ---------------------------------------------------------------------------
-- Settings: whether a review counts towards mastery by default
-- ---------------------------------------------------------------------------

alter table public.user_settings
  add column count_reviews_toward_mastery boolean not null default true;
