-- Schema version 9: the confidence behind the last standing answer.
--
-- Weak Words already knows what the reviewer's latest answer was. From here it
-- also knows how sure the reviewer felt before giving it, which separates a
-- word that merely slipped from one the reviewer believed was known — the word
-- that most needs looking at again.
--
-- Additive only; run this file once, after the version 8 file.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 9 $$;

-- ---------------------------------------------------------------------------
-- Card history: one more column, how sure the reviewer felt at the last answer
-- ---------------------------------------------------------------------------

-- The same rows and figures as before, with `last_confidence` appended: the
-- rating (1 low, 2 medium, 3 high) given before the answer that still stands
-- as the latest one. It is empty when that answer was saved before confidence
-- existed (version 5) or was given without a rating. Replacing a function
-- that returns a wider table needs the old one dropped first; nothing else
-- about it changes.
drop function public.card_review_stats(date);

create function public.card_review_stats(p_since date)
returns table (
  vocabulary_id uuid,
  reviews integer,
  failures integer,
  recent_reviews integer,
  recent_failures integer,
  -- Distinct days with at least one failure: forgetting a word on three
  -- separate days is worse than missing it three times in one sitting.
  failed_days integer,
  last_reviewed_on date,
  last_failed_on date,
  -- The most recent answer: 'remember' or 'not_remember'.
  last_action text,
  -- How sure the reviewer said they were before that answer.
  last_confidence integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    e.vocabulary_id,
    count(*)::integer,
    count(*) filter (where e.action = 'not_remember')::integer,
    count(*) filter (where e.reviewed_on >= p_since)::integer,
    count(*) filter (where e.reviewed_on >= p_since and e.action = 'not_remember')::integer,
    count(distinct e.reviewed_on) filter (where e.action = 'not_remember')::integer,
    max(e.reviewed_on),
    max(e.reviewed_on) filter (where e.action = 'not_remember'),
    (array_agg(e.action order by e.reviewed_at desc, e.id desc))[1],
    (array_agg(e.confidence order by e.reviewed_at desc, e.id desc))[1]::integer
  from public.effective_reviews e
  where e.user_id = (select auth.uid())
  group by e.vocabulary_id;
$$;

-- The drop took the old grants with it; the new function gets exactly the
-- same ones back, so only the signed-in account itself can call it.
revoke all on function public.card_review_stats(date) from anon, authenticated, public;
grant execute on function public.card_review_stats(date) to authenticated;
