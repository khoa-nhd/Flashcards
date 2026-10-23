-- Fix v15 partial application: add missing study_days columns and drop/recreate changed function
alter table public.study_days
  add column if not exists practice integer not null default 0 check (practice >= 0),
  add column if not exists practice_goal integer not null check (practice_goal between 0 and 1000);

alter table public.user_settings
  add column if not exists study_goal_practice integer check (study_goal_practice between 0 and 1000),
  add column if not exists maintenance_mode boolean not null default false;

drop function if exists public.study_day_counts(date);
