-- Purple Cow Meetings — image uploads for meeting notes
-- Run once in Supabase ▸ SQL Editor. Creates a public bucket for note images
-- and lets logged-in users upload to it.

-- 1) Public bucket
insert into storage.buckets (id, name, public)
values ('meeting-uploads', 'meeting-uploads', true)
on conflict (id) do update set public = true;

-- 2) Anyone logged in can upload; anyone can view (bucket is public)
drop policy if exists "meeting uploads insert" on storage.objects;
drop policy if exists "meeting uploads read"   on storage.objects;
drop policy if exists "meeting uploads delete" on storage.objects;

create policy "meeting uploads insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'meeting-uploads');

create policy "meeting uploads read" on storage.objects
  for select using (bucket_id = 'meeting-uploads');

create policy "meeting uploads delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'meeting-uploads');
