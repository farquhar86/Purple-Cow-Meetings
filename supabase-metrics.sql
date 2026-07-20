-- Purple Cow Meetings — Metrics / Scorecard table
-- Run once in Supabase ▸ SQL Editor.
-- Safe to re-run: everything is "if not exists" / dropped-then-created.

-- 1) Table: one row per metric. The metric's settings AND its weekly
--    values live together in the JSON blob, so editing one metric never
--    touches another (same safety model as priorities).
create table if not exists metrics (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- 2) Row Level Security: only logged-in users can touch metrics.
--    (Unlike the intake form, there is no anonymous access here.)
alter table metrics enable row level security;

drop policy if exists "managers read metrics"   on metrics;
drop policy if exists "managers write metrics"  on metrics;
drop policy if exists "authenticated metrics"   on metrics;

create policy "authenticated metrics" on metrics
  for all to authenticated using (true) with check (true);
