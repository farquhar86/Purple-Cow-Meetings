-- Purple Cow Meetings — Special Projects module
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- Special projects run outside the quarterly cycle, so they don't live in
-- `entries` (which is keyed by meeting/quarter). One row per project, the
-- same one-row-per-item safety model used by priorities, metrics, meeting
-- items and swimlanes so concurrent editors never overwrite each other.
--
-- data is the same JSON shape as a priority (title, pm, done[], plan[] …)
-- plus: special:true, status ('backlog'|'inprogress'|'blocked'|'done'),
-- ord (rank inside the column) and assignee (who is doing the work).

create table if not exists special_projects (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz default now()
);

alter table special_projects enable row level security;

drop policy if exists "authenticated special_projects" on special_projects;
create policy "authenticated special_projects" on special_projects
  for all to authenticated using (true) with check (true);
