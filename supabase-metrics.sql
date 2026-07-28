-- Purple Cow Meetings — Metrics / Scorecard tables
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.

-- 1) Metric definitions (name, owner, target, source, etc.)
create table if not exists metrics (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- 2) Weekly numbers — ONE ROW PER (metric, week) so two people entering
--    different weeks (or the same week) never overwrite each other.
create table if not exists metric_values (
  id          text primary key,        -- "<metric_id>|<week>"
  metric_id   text not null,
  wk          text not null,           -- week-start date, e.g. 2026-07-19
  value       jsonb,                   -- the number (or text) recorded
  updated_at  timestamptz default now()
);
create index if not exists metric_values_metric_idx on metric_values(metric_id);

-- 3) Row Level Security — any logged-in user can read/write.
alter table metrics       enable row level security;
alter table metric_values enable row level security;

drop policy if exists "authenticated metrics"        on metrics;
drop policy if exists "authenticated metric_values"  on metric_values;

create policy "authenticated metrics" on metrics
  for all to authenticated using (true) with check (true);
create policy "authenticated metric_values" on metric_values
  for all to authenticated using (true) with check (true);
