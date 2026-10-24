-- Version 16: the practice goal, on a database that already runs version 15.
--
-- Version 15 was first applied without the practice goal, and its file was
-- changed afterwards. Running that file again stops at study_day_counts,
-- whose result gained a column (create or replace cannot change it), so this
-- brings such a database up to date instead. It changes no data and removes
-- nothing: it adds two columns with defaults, rebuilds study_day_counts, adds
-- the record_study_day form with the practice goal, and can be run again.

create or replace function public.app_schema_version() returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 16 $$;

alter table public.study_days
  add column if not exists practice integer not null default 0 check (practice >= 0),
  -- Days recorded before the practice goal existed had none to meet.
  add column if not exists practice_goal integer not null default 0 check (practice_goal between 0 and 1000);

alter table public.user_settings
  add column if not exists study_goal_practice integer check (study_goal_practice between 0 and 1000),
  add column if not exists maintenance_mode boolean not null default false;

-- The result has a new column, so the function is replaced, not altered.
drop function if exists public.study_day_counts(date);

create function public.study_day_counts(p_day date)
returns table (new_words integer, reviews integer, practice integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with zone as (
    select coalesce(
      (select s.time_zone from public.user_settings s where s.user_id = (select auth.uid())),
      'UTC'
    ) as name
  ),
  answers as (
    select
      l.vocabulary_id,
      coalesce(l.counted_as_new, false) as is_new,
      case
        when coalesce(l.counted_as_new, false) then false
        when jsonb_typeof(l.fsrs_before) = 'object'
          then (l.fsrs_before ->> 'due')::timestamptz < ((l.reviewed_on + 1)::timestamp at time zone (select z.name from zone z))
        else l.due_on_before is null or l.due_on_before <= l.reviewed_on
      end as was_due
    from public.review_logs l
    where l.user_id = (select auth.uid())
      and l.kind = 'review'
      and l.reviewed_on = p_day
      and l.revision_after is not null
      and not exists (select 1 from public.review_logs u where u.undoes_log_id = l.id)
  ),
  counts as (
    select
      (count(distinct a.vocabulary_id) filter (where a.is_new))::integer as nw,
      (count(distinct a.vocabulary_id) filter (where a.was_due))::integer as rev
    from answers a
  ),
  prac as (
    select count(*)::integer as p
    from public.review_logs l
    where l.user_id = (select auth.uid())
      and l.kind = 'practice'
      and l.reviewed_on = p_day
  )
  select c.nw, c.rev, p.p
  from counts c, prac p
$$;

revoke all on function public.study_day_counts(date) from anon, authenticated, public;
grant execute on function public.study_day_counts(date) to authenticated;

-- Records how a day stands. `met` only ever goes from false to true.
-- Returns whether the day is met now.
create or replace function public.record_study_day(
  p_day date,
  p_new_words integer,
  p_reviews integer,
  p_practice integer,
  p_new_goal integer,
  p_review_goal integer,
  p_practice_goal integer,
  p_met boolean
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  insert into public.study_days as d (user_id, day, new_words, reviews, practice, new_goal, review_goal, practice_goal, met)
  values ((select auth.uid()), p_day, p_new_words, p_reviews, p_practice, p_new_goal, p_review_goal, p_practice_goal, p_met)
  on conflict (user_id, day) do update
    set new_words = excluded.new_words,
        reviews = excluded.reviews,
        practice = excluded.practice,
        new_goal = excluded.new_goal,
        review_goal = excluded.review_goal,
        practice_goal = excluded.practice_goal,
        met = d.met or excluded.met
  returning d.met
$$;

revoke all on function public.record_study_day(date, integer, integer, integer, integer, integer, integer, boolean) from anon, authenticated, public;
grant execute on function public.record_study_day(date, integer, integer, integer, integer, integer, integer, boolean) to authenticated;

-- The API reads functions from a cache; it is told to read them again.
notify pgrst, 'reload schema';
