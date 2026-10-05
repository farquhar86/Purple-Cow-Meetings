-- Purple Cow Meetings — Quarterly Reviews module
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- A quarterly review is a reviewee's self-assessment of a quarter, created by a
-- reviewer (who fills nothing in). One row per review. Unlike the rest of the app,
-- these are PRIVATE: row-level security below means the database itself only ever
-- returns a review to its reviewer, its reviewee, or a super admin — even over the
-- raw API. Everyone else is blocked at the source, not just hidden in the UI.
--
-- data (jsonb) shape:
--   { id, reviewer, reviewee, quarter,            -- quarter key e.g. '2026-Q4'
--     createdBy, createdAt, updatedAt, status,     -- 'draft' | 'submitted'
--     stage1:{ summary, metricNotes:{metricId:note} },
--     stage2:{ wentWell, improve },
--     stage3:{ goals:{metricId:target}, needs },   -- goals apply to the NEXT quarter
--     custom:[ {id, q, a} ],
--     depts:[ 'Operations', … ],                     -- department(s) the reviewee leads (optional)
--     prio:{ notes:{priorityId:note}, overall },     -- stage 2 Priorities answers
--     deleted, deletedBy, deletedAt }                 -- set when the creator deletes their own
--                                                     -- review but isn't its reviewer; hidden everywhere
-- (depts/prio live inside data, so no table change is needed for them.)
-- reviewer_email / reviewee_email / quarter are mirrored into columns so the RLS
-- policies (and quarter filtering) can read them without cracking open the JSON.

create table if not exists reviews (
  id             text primary key,
  reviewer_email text not null,
  reviewee_email text not null,
  quarter        text not null,
  data           jsonb not null,
  updated_at     timestamptz default now()
);

create index if not exists reviews_reviewee_idx on reviews (lower(reviewee_email));
create index if not exists reviews_reviewer_idx on reviews (lower(reviewer_email));
create index if not exists reviews_quarter_idx  on reviews (quarter);

alter table reviews enable row level security;

-- Who the current request is, and whether they're a super admin. The role lives in
-- the JWT's app_metadata (set by the user-management function), so the database can
-- trust it without an extra lookup.
--   super admin            → every review
--   reviewer or reviewee   → only reviews they're part of
-- Emails are compared case-insensitively.

drop policy if exists "reviews_select" on reviews;
create policy "reviews_select" on reviews for select to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin'
  or lower(reviewer_email) = lower(coalesce(auth.jwt() ->> 'email',''))
  or lower(reviewee_email) = lower(coalesce(auth.jwt() ->> 'email',''))
);

-- Anyone signed in can create a review (e.g. set one up for a direct report). Who can
-- then SEE it is still locked down by the select policy above — creating one you're not
-- part of just hands it off to the people who are.
drop policy if exists "reviews_insert" on reviews;
create policy "reviews_insert" on reviews for insert to authenticated
with check (true);

-- Reviewer, reviewee, or super admin can edit (reviewee fills answers; reviewer can
-- adjust the custom questions). The row must still belong to them afterwards.
drop policy if exists "reviews_update" on reviews;
create policy "reviews_update" on reviews for update to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin'
  or lower(reviewer_email) = lower(coalesce(auth.jwt() ->> 'email',''))
  or lower(reviewee_email) = lower(coalesce(auth.jwt() ->> 'email',''))
)
with check (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin'
  or lower(reviewer_email) = lower(coalesce(auth.jwt() ->> 'email',''))
  or lower(reviewee_email) = lower(coalesce(auth.jwt() ->> 'email',''))
);

-- Only the reviewer who owns it, or a super admin, can delete a review row. (In the app,
-- whoever created a review can also delete it; when they aren't the reviewer the app marks
-- it deleted instead, which the update policy above allows.)
drop policy if exists "reviews_delete" on reviews;
create policy "reviews_delete" on reviews for delete to authenticated
using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'superadmin'
  or lower(reviewer_email) = lower(coalesce(auth.jwt() ->> 'email',''))
);
