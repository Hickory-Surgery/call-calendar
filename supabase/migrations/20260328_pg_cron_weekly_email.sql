-- Set up pg_cron to call the weekly-email edge function every 30 minutes.
-- The function itself checks whether it's the right day/time to send.
--
-- Prerequisites:
--   1. Enable pg_cron in Supabase: Database → Extensions → pg_cron
--   2. Enable pg_net in Supabase: Database → Extensions → pg_net
--   3. CRON_SECRET must be set as an edge function secret:
--        supabase secrets set CRON_SECRET=<your-secret> --project-ref <ref>
--   4. Fill in YOUR_PROJECT_REF and YOUR_CRON_SECRET below, then run in SQL editor.
--   5. Set email_day and email_time in the Practice settings tab of the app.

select cron.schedule(
  'weekly-email-heartbeat',
  '*/30 * * * *',
  $cmd$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/weekly-email',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body    := '{}'::jsonb
  );
  $cmd$
);

-- To remove the job later:
-- select cron.unschedule('weekly-email-heartbeat');

-- To list scheduled jobs:
-- select * from cron.job;
