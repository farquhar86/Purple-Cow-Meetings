-- Purple Cow Meetings — Meetings module
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.

-- Meeting definitions (title, type, date/time, attendees, section layout).
create table if not exists mtgs (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

-- Everything people type INTO a meeting is one row per item, so two people
-- editing different notes / priorities at the same time never overwrite
-- each other (same safety model as priorities and metrics).
create table if not exists mtg_items (
  id          text primary key,
  meeting_id  text not null,
  section     text,                 -- which section it belongs to
  inst        text,                 -- meeting date it belongs to (or 'static' = every date)
  data        jsonb not null,       -- { type, text, author, done, order, t }
  updated_at  timestamptz default now()
);
create index if not exists mtg_items_meeting_idx on mtg_items(meeting_id);

alter table mtgs      enable row level security;
alter table mtg_items enable row level security;

drop policy if exists "authenticated mtgs"      on mtgs;
drop policy if exists "authenticated mtg_items" on mtg_items;

create policy "authenticated mtgs" on mtgs
  for all to authenticated using (true) with check (true);
create policy "authenticated mtg_items" on mtg_items
  for all to authenticated using (true) with check (true);
