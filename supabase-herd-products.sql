-- Round Up: live product breakdown for Active Herd Members (internet, fibre, mobile, TV, home phone)
-- Run once in Supabase ▸ SQL Editor AFTER the herd-products Edge Function is deployed. Safe to re-run.
--
-- One row per pull from Salesforce. The popup shows the newest good row, and turns amber when the
-- newest row is a failed pull or the newest good one is more than an hour old.
-- Only the herd-products function writes here (it uses the service role); logged-in people can read.

create table if not exists public.herd_product_counts (
  id              bigserial primary key,
  taken_at        timestamptz not null default now(),
  internet        integer,
  cable           integer,
  fibre           integer,
  mobile_lines    integer,
  mobile_members  integer,
  mobile_only     integer,
  tv              integer,
  phone           integer,
  source          text,             -- 'schedule' or 'refresh:<who pressed it>'
  ok              boolean not null default true,
  error           text
);

create index if not exists herd_product_counts_taken_at on public.herd_product_counts (taken_at desc);

alter table public.herd_product_counts enable row level security;

drop policy if exists "authenticated read herd_product_counts" on public.herd_product_counts;
create policy "authenticated read herd_product_counts" on public.herd_product_counts
  for select to authenticated using (true);

-- ---- Schedule: every 15 minutes ----
-- The cron job sends the same SYNC_SECRET the function has, read from Supabase Vault so the
-- secret never sits in this (public) repo. ONE TIME, before running the block below, run this
-- line on its own in the SQL Editor with the real value pasted in (and don't save it back here):
--
--   select vault.create_secret('<the SYNC_SECRET value>', 'herd_sync_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('herd-products-15min') where exists (select 1 from cron.job where jobname = 'herd-products-15min');

select cron.schedule(
  'herd-products-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://pabuedfwiinvlhvmrslm.functions.supabase.co/herd-products',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'herd_sync_secret')
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Handy checks:
--   select taken_at, ok, internet, cable, fibre, mobile_lines, tv, phone, error, source
--     from public.herd_product_counts order by taken_at desc limit 10;     -- latest pulls
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'herd-products-15min')
--     order by start_time desc limit 5;                                     -- scheduler runs
-- To stop the schedule:  select cron.unschedule('herd-products-15min');
