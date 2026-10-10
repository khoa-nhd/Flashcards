-- Schema version 4: analytics computed in the database.
--
-- Two read-only functions that summarise the caller's own saved reviews, so
-- the browser never has to download the whole history. Both count only
-- answers that still stand (not undone), and both run as the caller under Row
-- Level Security. Nothing is stored or changed. Run once, after version 3.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 4 $$;

-- One row per calendar day and study mode on which the caller reviewed.
-- "Day" is the reviewer's own calendar day, recorded with each answer when it
-- was saved, so a later change of time zone does not move past reviews.
create function public.review_daily_stats(p_from date, p_to date)
returns table (
  day date,
  review_mode text,
  reviews integer,
  remembered integer,
  not_remembered integer,
  -- Answers to a card that already had an earlier standing answer, and how
  -- many of those were remembered: the basis for observed retention.
  repeat_reviews integer,
  repeat_remembered integer,
  duration_ms bigint,
  timed_reviews integer,
  cards integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select e.*,
           exists (
             select 1 from public.effective_reviews p
              where p.user_id = e.user_id
                and p.vocabulary_id = e.vocabulary_id
                and (p.reviewed_at, p.id) < (e.reviewed_at, e.id)
           ) as seen_before
      from public.effective_reviews e
     where e.user_id = (select auth.uid())
       and e.reviewed_on between p_from and p_to
  )
  select
    m.reviewed_on,
    m.review_mode,
    count(*)::integer,
    count(*) filter (where m.action = 'remember')::integer,
    count(*) filter (where m.action = 'not_remember')::integer,
    count(*) filter (where m.seen_before)::integer,
    count(*) filter (where m.seen_before and m.action = 'remember')::integer,
    coalesce(sum(m.duration_ms), 0)::bigint,
    count(m.duration_ms)::integer,
    count(distinct m.vocabulary_id)::integer
  from mine m
  group by m.reviewed_on, m.review_mode
  order by m.reviewed_on, m.review_mode;
$$;

-- One row per word the caller has reviewed: how it has gone overall and since
-- `p_since`. Words never reviewed have no row.
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
  last_action text
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
    (array_agg(e.action order by e.reviewed_at desc, e.id desc))[1]
  from public.effective_reviews e
  where e.user_id = (select auth.uid())
  group by e.vocabulary_id;
$$;

revoke all on function public.review_daily_stats(date, date) from anon, authenticated, public;
revoke all on function public.card_review_stats(date) from anon, authenticated, public;
grant execute on function public.review_daily_stats(date, date) to authenticated;
grant execute on function public.card_review_stats(date) to authenticated;
