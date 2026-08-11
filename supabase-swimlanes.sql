-- Purple Cow Meetings — Swimlanes module
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- One table holds everything for the Swimlanes tab, one row per item:
--   kind = 'lane'   → a swimlane (name, colour, owner, order)
--   kind = 'card'   → a block inside a lane for a given quarter
--   kind = 'config' → the quarter range shown (id = 'config')
-- One-row-per-item keeps concurrent editors from overwriting each other,
-- the same safety model used by priorities, metrics and meeting items.

create table if not exists swimlanes (
  id          text primary key,
  kind        text not null,          -- 'lane' | 'card' | 'config'
  data        jsonb not null,
  updated_at  timestamptz default now()
);

alter table swimlanes enable row level security;

drop policy if exists "authenticated swimlanes" on swimlanes;
create policy "authenticated swimlanes" on swimlanes
  for all to authenticated using (true) with check (true);
