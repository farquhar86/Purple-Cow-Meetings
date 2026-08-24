-- Purple Cow Meetings — weekly MDU metric sync schedule
-- Runs the sync-mdu-metric Edge Function every Monday evening.
-- Run once in Supabase ▸ SQL Editor AFTER the function is deployed.

-- 1) Enable the scheduler + HTTP extensions (safe to re-run)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) (Re)schedule the weekly job.
--    23:00 UTC Monday ≈ 8:00 PM Atlantic (ADT, summer) / 7:00 PM (AST, winter).
--    Adjust the time in the cron expression '0 23 * * 1' if you want it earlier/later
--    (format: minute hour day-of-month month day-of-week; day-of-week 1 = Monday).
select cron.unschedule('mdu-weekly') where exists (select 1 from cron.job where jobname = 'mdu-weekly');

select cron.schedule(
  'mdu-weekly',
  '0 23 * * 1',
  $$
  select net.http_post(
    url     := 'https://pabuedfwiinvlhvmrslm.functions.supabase.co/sync-mdu-metric',
    headers := '{"Content-Type":"application/json","x-sync-secret":"pcmdu_19297495e4223f89aef0d120d7a2a778d35d"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Handy checks:
--   select * from cron.job;                              -- see the schedule
--   select * from cron.job_run_details order by start_time desc limit 5;   -- see recent runs
--
-- To trigger it right now (fills in this week immediately), run just the net.http_post above,
-- or in a terminal:
--   curl -X POST https://pabuedfwiinvlhvmrslm.functions.supabase.co/sync-mdu-metric \
--     -H "x-sync-secret: pcmdu_19297495e4223f89aef0d120d7a2a778d35d"
