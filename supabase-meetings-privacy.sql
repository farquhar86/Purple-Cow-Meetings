-- Purple Cow Meetings — keep meetings private to the people in them
-- Run once in Supabase ▸ SQL Editor, AFTER supabase-meetings.sql. Safe to re-run.
--
-- Why: the original policies let any signed-in person read and change every
-- meeting and everything typed into it. The app only hid other people's
-- meetings on screen, so a private 1:1's setup, notes, to-dos and issues still
-- reached every browser (and the Claude connector) behind the scenes.
--
-- After this runs, the database only hands out what the app already shows:
--   Meetings (mtgs): attendees, the organizer, whoever created it, and superadmins.
--   Items in a meeting (mtg_items: notes, topics, to-dos, issues):
--     - everyone who can see that meeting
--     - a to-do's assignee and whoever assigned it, even if they aren't in the meeting
--     - an issue shared into another meeting ("alsoIn") is seen by that meeting too
--     - superadmins see everything
--   To-dos made on the To-Dos page (meeting_id 'standalone') and app-wide rows
--   such as the Vision page ('app-vision') stay open to everyone signed in, as before.
--
-- Roles come from the account's app_metadata.role (set in the Team panel).

-- ---------- helpers ----------
create or replace function pc_me() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function pc_is_superadmin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'superadmin'
$$;

-- Can the signed-in person see a meeting, judged from the meeting's own data?
create or replace function pc_mtg_data_visible(d jsonb) returns boolean
language sql stable as $$
  select pc_is_superadmin()
      or (pc_me() <> '' and (
            (jsonb_typeof(d -> 'attendees') = 'array'
              and exists (select 1 from jsonb_array_elements_text(d -> 'attendees') a
                          where lower(a) = pc_me()))
         or lower(coalesce(d ->> 'organizer', '')) = pc_me()
         or lower(coalesce(d ->> 'by', '')) = pc_me()))
$$;

-- Same check by meeting id. Security definer so it can look the meeting up
-- without tripping over the mtgs policy below; it only ever returns true/false.
create or replace function pc_can_see_mtg(mid text) returns boolean
language sql stable security definer set search_path = public as $$
  select pc_is_superadmin()
      or exists (select 1 from mtgs where id = mid and pc_mtg_data_visible(data))
$$;

-- Can the signed-in person see an item (note, topic, to-do, issue...)?
create or replace function pc_item_visible(mid text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select pc_is_superadmin()
      or mid = 'standalone'
      or pc_can_see_mtg(mid)
      or (pc_me() <> '' and (d ->> 'type') = 'pri'
          and pc_me() in (lower(coalesce(d ->> 'author', '')),
                          lower(coalesce(d ->> 'owner', '')),
                          lower(coalesce(d ->> 'assignedBy', ''))))
      or (jsonb_typeof(d -> 'alsoIn') = 'array'
          and exists (select 1 from jsonb_array_elements_text(d -> 'alsoIn') x
                      where pc_can_see_mtg(x)))
$$;

-- ---------- meetings ----------
alter table mtgs enable row level security;
drop policy if exists "authenticated mtgs" on mtgs;
drop policy if exists "mtgs read"   on mtgs;
drop policy if exists "mtgs add"    on mtgs;
drop policy if exists "mtgs change" on mtgs;
drop policy if exists "mtgs remove" on mtgs;

create policy "mtgs read" on mtgs for select to authenticated
  using (id like 'app-%' or pc_mtg_data_visible(data));
-- New meetings must include their creator (the app always stamps "by").
create policy "mtgs add" on mtgs for insert to authenticated
  with check (id like 'app-%' or pc_mtg_data_visible(data));
-- Anyone who can see a meeting can edit it. The saved meeting still has to include
-- them, so only the organizer or creator can take themselves off the attendee list.
create policy "mtgs change" on mtgs for update to authenticated
  using (id like 'app-%' or pc_mtg_data_visible(data))
  with check (id like 'app-%' or pc_mtg_data_visible(data));
create policy "mtgs remove" on mtgs for delete to authenticated
  using (id like 'app-%' or pc_mtg_data_visible(data));

-- ---------- items typed into meetings ----------
alter table mtg_items enable row level security;
drop policy if exists "authenticated mtg_items" on mtg_items;
drop policy if exists "mtg_items read"   on mtg_items;
drop policy if exists "mtg_items add"    on mtg_items;
drop policy if exists "mtg_items change" on mtg_items;
drop policy if exists "mtg_items remove" on mtg_items;

create policy "mtg_items read" on mtg_items for select to authenticated
  using (pc_item_visible(meeting_id, data));
create policy "mtg_items add" on mtg_items for insert to authenticated
  with check (pc_item_visible(meeting_id, data));
create policy "mtg_items change" on mtg_items for update to authenticated
  using (pc_item_visible(meeting_id, data))
  with check (pc_item_visible(meeting_id, data));
create policy "mtg_items remove" on mtg_items for delete to authenticated
  using (pc_item_visible(meeting_id, data));
