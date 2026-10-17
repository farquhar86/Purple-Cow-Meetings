-- ============================================================================================
-- Round Up: role rules in the database (Oct 2026)
--
-- Until now the database only checked that someone was logged in. The app hid things from
-- Team-role users, but anyone with a login could still change anything by going around the app.
-- This file makes the database enforce the same rules the app already shows people:
--
--   Super Admin, Admin, Leadership   no change: they can do what they do today.
--   Team                             can update the priorities and special projects they PM,
--                                    are assigned to, or own a task on; can update the metrics
--                                    they own (or review, for next-quarter targets) and those
--                                    metrics' weekly numbers. Can't create or delete priorities,
--                                    metrics, special projects, quarters or swimlanes, and can't
--                                    edit the Vision page. On a priority they're on, they can
--                                    still edit anything the app lets them edit, same as today.
--   Signed out (the intake form)     can still submit ideas, but can't slip in a priority that's
--                                    already committed, scheduled or has a PM. (Before this, the
--                                    public form's key could post anything to the dashboard.)
--
-- A login with no role set counts as Admin, the same as the app. A login whose account has
-- been removed counts as nothing (no extra rights).
--
-- How it works: every rule below is RESTRICTIVE, so it sits on top of the existing rules and
-- only takes away what Team users could do. Nothing existing is dropped or changed, the intake
-- form still works for everyone, and the undo script (supabase-role-rules-undo.sql) just drops
-- what this file adds.
--
-- Not covered here: meetings and what's typed into them (notes, to-dos, issues). Who can see
-- and change those is set by supabase-meetings-privacy.sql (attendees only). Within a meeting,
-- the app re-saves items other people wrote and lets any attendee move issue cards, so no
-- per-role rule is added on top. The Claude connector applies the app's to-do rules itself.
-- The only meeting-table rule here keeps Team users from editing the Vision page.
--
-- Also adds two things the Claude connector uses:
--   ru_save_if_unchanged()  saves a change only if nobody else changed that record since Claude
--                           read it, so Claude never wipes out someone's edit.
--   connector_log           a record of every change made through Claude: who, when, what.
--
-- Run it once in Supabase > SQL Editor. It's safe to run again.
-- ============================================================================================

-- ---------- Who is asking -------------------------------------------------------------------
-- Read from the login itself, so a role change takes effect right away.

create or replace function public.ru_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = auth.uid()
$$;

create or replace function public.ru_role()
returns text language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then 'anon'
    when not exists (select 1 from auth.users u where u.id = auth.uid()) then 'none'  -- account removed
    else coalesce(
      (select nullif(lower(u.raw_app_meta_data->>'role'), '') from auth.users u where u.id = auth.uid()),
      'admin')                                        -- no role set: the app treats it as Admin
  end
$$;

-- Super Admin, Admin or Leadership: the roles the app lets create and edit everything.
create or replace function public.ru_full()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.ru_role() in ('superadmin', 'admin', 'leadership')
$$;

-- Is this person the PM, the assignee, or a task owner on this priority / special project?
-- (Emails only, case-insensitive, the same as what the app lets Team users open.)
create or replace function public.ru_is_on(d jsonb, who text)
returns boolean language sql immutable set search_path = '' as $$
  select who is not null and who <> '' and (
       lower(coalesce(d->>'pm', '')) = who
    or lower(coalesce(d->>'assignee', '')) = who
    or exists (
         select 1
         from jsonb_array_elements(case when jsonb_typeof(d->'plan') = 'array' then d->'plan' else '[]'::jsonb end) p
         where jsonb_typeof(p) = 'object' and lower(coalesce(p->>'owner', '')) = who))
$$;

-- Does this person own this metric?
create or replace function public.ru_owns_metric(mid text, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select who is not null and who <> '' and exists (
    select 1 from public.metrics m
    where m.id = mid and lower(coalesce(m.data->>'owner', '')) = who)
$$;

-- Is this person the reviewer on a Quarterly Review of this metric's owner? (Approving a
-- review writes next-quarter targets onto the reviewee's metrics.)
create or replace function public.ru_reviews(owner_email text, who text)
returns boolean language sql stable security definer set search_path = '' as $$
  select who is not null and who <> '' and coalesce(owner_email, '') <> '' and exists (
    select 1 from public.reviews r
    where lower(r.reviewer_email) = who and lower(r.reviewee_email) = lower(owner_email))
$$;

-- Is there already a record with this id? The app saves with "insert, or update if it's
-- already there", and the database checks the insert rule even when it ends up updating.
-- So "Team can't create" has to let through saves to records that already exist; the update
-- rule then decides whether this person may change that record.
create or replace function public.ru_exists(p_table text, p_id text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare found boolean;
begin
  if p_table not in ('entries', 'metrics', 'special_projects') then return false; end if;
  execute format('select exists (select 1 from public.%I where id = $1)', p_table) into found using p_id;
  return found;
end $$;

-- Only signed-in people can call these, except the three the intake form's rule needs.
revoke all on function public.ru_email()                 from public, anon;
revoke all on function public.ru_role()                  from public;
revoke all on function public.ru_full()                  from public;
revoke all on function public.ru_is_on(jsonb, text)      from public, anon;
revoke all on function public.ru_owns_metric(text, text) from public, anon;
revoke all on function public.ru_reviews(text, text)     from public, anon;
revoke all on function public.ru_exists(text, text)      from public;
grant execute on function public.ru_email()                 to authenticated;
grant execute on function public.ru_role()                  to anon, authenticated;
grant execute on function public.ru_full()                  to anon, authenticated;
grant execute on function public.ru_is_on(jsonb, text)      to authenticated;
grant execute on function public.ru_owns_metric(text, text) to authenticated;
grant execute on function public.ru_reviews(text, text)     to authenticated;
grant execute on function public.ru_exists(text, text)      to anon, authenticated;

-- ---------- Priorities and the rest of the quarter's entries (entries) ----------------------
-- The intake form lets anyone submit, signed in or not. A submission is a plain idea: it never
-- carries a plan, stage, PM, size or Definition of Done. So for signed-out people and Team users,
-- a new entry has to look like that. Saving an entry that already exists goes to the update
-- rule below instead (the app saves with "insert, or update if it's already there").

drop policy if exists "ru intake insert entries" on public.entries;
create policy "ru intake insert entries" on public.entries
  as restrictive for insert to anon, authenticated
  with check ((select public.ru_full())
              or public.ru_exists('entries', id)
              or not (data ?| array['plan', 'stage', 'committed', 'completed', 'reviewed', 'size', 'pm', 'dod', 'dodMet', 'special']));

drop policy if exists "ru team update entries" on public.entries;
create policy "ru team update entries" on public.entries
  as restrictive for update to authenticated
  using ((select public.ru_full())
         or (data->>'type' = 'priority' and public.ru_is_on(data, (select public.ru_email()))))
  with check (true);

drop policy if exists "ru team delete entries" on public.entries;
create policy "ru team delete entries" on public.entries
  as restrictive for delete to authenticated
  using ((select public.ru_full()));

-- ---------- Quarters (meetings) --------------------------------------------------------------

drop policy if exists "ru team insert meetings" on public.meetings;
create policy "ru team insert meetings" on public.meetings
  as restrictive for insert to authenticated
  with check ((select public.ru_full()));

drop policy if exists "ru team update meetings" on public.meetings;
create policy "ru team update meetings" on public.meetings
  as restrictive for update to authenticated
  using ((select public.ru_full())) with check (true);

drop policy if exists "ru team delete meetings" on public.meetings;
create policy "ru team delete meetings" on public.meetings
  as restrictive for delete to authenticated
  using ((select public.ru_full()));

-- ---------- Metrics ----------------------------------------------------------------------

drop policy if exists "ru team insert metrics" on public.metrics;
create policy "ru team insert metrics" on public.metrics
  as restrictive for insert to authenticated
  with check ((select public.ru_full()) or public.ru_exists('metrics', id));

drop policy if exists "ru team update metrics" on public.metrics;
create policy "ru team update metrics" on public.metrics
  as restrictive for update to authenticated
  using ((select public.ru_full())
         or lower(coalesce(data->>'owner', '')) = (select public.ru_email())
         or public.ru_reviews(data->>'owner', (select public.ru_email())))
  with check (true);

drop policy if exists "ru team delete metrics" on public.metrics;
create policy "ru team delete metrics" on public.metrics
  as restrictive for delete to authenticated
  using ((select public.ru_full()));

-- ---------- Weekly metric numbers (metric_values) -------------------------------------------
-- Team users: only on metrics they own, and only under the usual "<metric>|<week>" id.

drop policy if exists "ru team insert metric_values" on public.metric_values;
create policy "ru team insert metric_values" on public.metric_values
  as restrictive for insert to authenticated
  with check ((select public.ru_full())
              or (id = metric_id || '|' || wk and public.ru_owns_metric(metric_id, (select public.ru_email()))));

drop policy if exists "ru team update metric_values" on public.metric_values;
create policy "ru team update metric_values" on public.metric_values
  as restrictive for update to authenticated
  using ((select public.ru_full())
         or public.ru_owns_metric(metric_id, (select public.ru_email())))
  with check ((select public.ru_full())
              or (id = metric_id || '|' || wk and public.ru_owns_metric(metric_id, (select public.ru_email()))));

drop policy if exists "ru team delete metric_values" on public.metric_values;
create policy "ru team delete metric_values" on public.metric_values
  as restrictive for delete to authenticated
  using ((select public.ru_full())
         or public.ru_owns_metric(metric_id, (select public.ru_email())));

-- ---------- Special projects ------------------------------------------------------------------

drop policy if exists "ru team insert special_projects" on public.special_projects;
create policy "ru team insert special_projects" on public.special_projects
  as restrictive for insert to authenticated
  with check ((select public.ru_full()) or public.ru_exists('special_projects', id));

drop policy if exists "ru team update special_projects" on public.special_projects;
create policy "ru team update special_projects" on public.special_projects
  as restrictive for update to authenticated
  using ((select public.ru_full()) or public.ru_is_on(data, (select public.ru_email())))
  with check (true);

drop policy if exists "ru team delete special_projects" on public.special_projects;
create policy "ru team delete special_projects" on public.special_projects
  as restrictive for delete to authenticated
  using ((select public.ru_full()));

-- ---------- Swimlanes --------------------------------------------------------------------------

drop policy if exists "ru team insert swimlanes" on public.swimlanes;
create policy "ru team insert swimlanes" on public.swimlanes
  as restrictive for insert to authenticated
  with check ((select public.ru_full()));

drop policy if exists "ru team update swimlanes" on public.swimlanes;
create policy "ru team update swimlanes" on public.swimlanes
  as restrictive for update to authenticated
  using ((select public.ru_full())) with check (true);

drop policy if exists "ru team delete swimlanes" on public.swimlanes;
create policy "ru team delete swimlanes" on public.swimlanes
  as restrictive for delete to authenticated
  using ((select public.ru_full()));

-- ---------- The Vision page (the 'app-vision' row in mtgs) ----------------------------------
-- Meetings themselves stay as they are; only the Vision page is locked for Team users.

drop policy if exists "ru team insert vision" on public.mtgs;
create policy "ru team insert vision" on public.mtgs
  as restrictive for insert to authenticated
  with check ((select public.ru_full()) or id <> 'app-vision');

drop policy if exists "ru team update vision" on public.mtgs;
create policy "ru team update vision" on public.mtgs
  as restrictive for update to authenticated
  using ((select public.ru_full()) or id <> 'app-vision')
  with check ((select public.ru_full()) or id <> 'app-vision');

drop policy if exists "ru team delete vision" on public.mtgs;
create policy "ru team delete vision" on public.mtgs
  as restrictive for delete to authenticated
  using ((select public.ru_full()) or id <> 'app-vision');

-- ---------- For the Claude connector: save only if nobody changed it in between ------------
-- Runs as the person asking, so every rule above still applies. Returns false (and saves
-- nothing) when the record changed since Claude read it, or when the rules say no.

create or replace function public.ru_save_if_unchanged(p_table text, p_id text, p_expected jsonb, p_new jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if p_table not in ('entries', 'special_projects', 'mtg_items') then
    raise exception 'ru_save_if_unchanged: % is not allowed', p_table;
  end if;
  execute format('update public.%I set data = $1, updated_at = now() where id = $2 and data = $3', p_table)
    using p_new, p_id, p_expected;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.ru_save_if_unchanged(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.ru_save_if_unchanged(text, text, jsonb, jsonb) to authenticated;

-- ---------- For the Claude connector: a record of every change made through Claude ---------

create table if not exists public.connector_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  by_email   text not null,
  tool       text not null,
  target     text,
  summary    text,
  before     jsonb,
  after      jsonb
);
alter table public.connector_log enable row level security;

-- People can only add entries under their own email; nobody can edit or delete them.
drop policy if exists "ru log add own" on public.connector_log;
create policy "ru log add own" on public.connector_log
  for insert to authenticated
  with check (lower(by_email) = (select public.ru_email()));

-- Admins and Super Admins see everything; everyone else sees their own.
drop policy if exists "ru log read" on public.connector_log;
create policy "ru log read" on public.connector_log
  for select to authenticated
  using ((select public.ru_role()) in ('admin', 'superadmin')
         or lower(by_email) = (select public.ru_email()));

revoke all on public.connector_log from anon;
revoke update, delete, truncate on public.connector_log from authenticated;
grant select, insert on public.connector_log to authenticated;
