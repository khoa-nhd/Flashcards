-- Schema version 12: the Speaking practice mode.
--
-- Saying a word aloud is a practice mode like the rest: the browser's own
-- speech recognition writes down what it heard, that transcript is judged
-- exactly as typing judges it, and nothing here touches a word's mastery,
-- review date or FSRS state. Only the list of accepted mode names widens —
-- the same shape as version 10 did for writing. Dropping the check and
-- adding it back touches no stored value: every mode name already accepted
-- still satisfies it. No function changes: record_practice only ever refuses
-- the flashcard name, which stays refused.
--
-- Additive only; run this file once, after the version 11 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 12 $$;

-- The same list as version 10, with speaking appended.
alter table public.review_logs
  drop constraint review_logs_mode_check;

alter table public.review_logs
  add constraint review_logs_mode_check
    check (review_mode in ('flashcard', 'recognition', 'recall', 'typing', 'cloze', 'listening', 'writing', 'speaking'));
