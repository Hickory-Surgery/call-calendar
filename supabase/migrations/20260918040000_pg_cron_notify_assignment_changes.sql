-- Set up pg_cron to call the notify-assignment-changes edge function once daily at
-- 09:00 UTC (4am EST — fixed UTC time, does not shift for daylight saving).
--
-- Prerequisites:
--   1. pg_cron and pg_net must already be enabled (done for weekly-email-heartbeat).
--   2. CRON_SECRET is already set as an edge function secret (shared with weekly-email —
--      Supabase edge function secrets are project-wide, not per-function).
--   3. notify-assignment-changes has verify_jwt = false (see supabase/config.toml), so
--      unlike weekly-email's cron job, no Authorization header is needed here — the
--      function validates x-cron-secret itself.
--   4. Fill in YOUR_PROJECT_REF and YOUR_CRON_SECRET below, then run in the SQL editor.

select cron.schedule(
  'notify-assignment-changes-daily',
  '0 9 * * *',
  $cmd$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-assignment-changes',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
  $cmd$
);

-- To remove the job later:
-- select cron.unschedule('notify-assignment-changes-daily');

-- To list scheduled jobs:
-- select * from cron.job;
