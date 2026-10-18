-- Schema version 14: a weak word can be recovered.
--
-- One row per word per day of its answers, review and practice together, so
-- the recovery rule can be worked out from saved answers alone: how many
-- points that day is worth, how many times it was forgotten, and what the last
-- answer was. Answers taken back with Undo are left out, as everywhere else.
-- Run once, after version 13. `create or replace` so that a run the SQL Editor
-- stopped partway can simply be run again.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 14 $$;

create or replace function public.weak_word_days()
returns table (
  vocabulary_id uuid,
  day date,
  review_answers integer,
  review_fails integer,
  practice_answers integer,
  practice_fails integer,
  -- Correct answers' weight that day, capped at one: 1 for an auto-graded
  -- answer, 0.5 for one the reviewer judged themselves.
  day_points numeric,
  -- The last answer of the day, as the weak list reads it.
  last_action text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with answers as (
    select
      e.vocabulary_id,
      e.reviewed_on as day,
      e.kind = 'review' as is_review,
      case when e.kind = 'review' then e.action = 'remember' else e.answer_correct end as remembered,
      case when e.grading = 'auto' then 1.0 else 0.5 end as weight,
      e.reviewed_at,
      e.id
    from public.review_logs e
    where e.user_id = (select auth.uid())
      and e.kind in ('review', 'practice')
      and not exists (select 1 from public.review_logs u where u.undoes_log_id = e.id)
  ),
  per_day as (
    select
      a.vocabulary_id,
      a.day,
      count(*) filter (where a.is_review)::integer as review_answers,
      count(*) filter (where a.is_review and not a.remembered)::integer as review_fails,
      count(*) filter (where not a.is_review)::integer as practice_answers,
      count(*) filter (where not a.is_review and not a.remembered)::integer as practice_fails,
      least(1, coalesce(sum(a.weight) filter (where a.remembered), 0))::numeric as day_points,
      (array_agg(case when a.remembered then 'remember' else 'not_remember' end
                    order by a.reviewed_at desc, a.id desc))[1] as last_action
    from answers a
    group by a.vocabulary_id, a.day
  )
  select
    p.vocabulary_id,
    p.day,
    p.review_answers,
    p.review_fails,
    p.practice_answers,
    p.practice_fails,
    p.day_points,
    p.last_action
  from per_day p
  order by p.vocabulary_id, p.day;
$$;

revoke all on function public.weak_word_days() from anon, authenticated, public;
grant execute on function public.weak_word_days() to authenticated;
