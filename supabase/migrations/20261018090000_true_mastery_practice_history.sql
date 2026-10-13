-- Schema version 9: practice history for True Mastery estimation.
--
-- Adds a function to fetch practice history per word, with enough detail
-- to compute a True Mastery estimate: correctness, timestamps, mode,
-- grading method, session id, and duration.
-- Run once, after version 8.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 9 $$;

-- ---------------------------------------------------------------------------
-- Practice history per word: one row per saved practice answer
-- ---------------------------------------------------------------------------

-- Returns the caller's own practice history, one row per answer that still
-- stands (not undone), ordered oldest first. Includes everything needed to
-- compute a True Mastery estimate: correctness, recency, mode, grading
-- method, session, and duration.
create function public.practice_history(p_since date default null)
returns table (
  vocabulary_id uuid,
  review_mode text,
  answer_correct boolean,
  grading text,
  submitted_answer text,
  reviewed_on date,
  reviewed_at timestamptz,
  duration_ms bigint,
  confidence smallint,
  session_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.vocabulary_id,
    l.review_mode,
    l.answer_correct,
    l.grading,
    l.submitted_answer,
    l.reviewed_on,
    l.reviewed_at,
    l.duration_ms,
    l.confidence,
    l.session_id
  from public.review_logs l
  where l.user_id = (select auth.uid())
    and l.kind = 'practice'
    and not exists (
      select 1 from public.review_logs u
      where u.undoes_log_id = l.id
    )
    and (p_since is null or l.reviewed_on >= p_since)
  order by l.reviewed_at, l.id;
$$;

revoke all on function public.practice_history(date) from anon, authenticated, public;
grant execute on function public.practice_history(date) to authenticated;