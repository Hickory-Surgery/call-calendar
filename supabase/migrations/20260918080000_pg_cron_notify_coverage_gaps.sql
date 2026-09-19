-- Set up pg_cron to call the notify-coverage-gaps edge function once daily at 07:00 UTC.
-- The function itself decides internally whether today is actually "2 business days
-- before the configured weekly-email day" before doing anything.
--
-- Run in the SQL editor. Reuses the same secret already stored on weekly-email-heartbeat
-- (CRON_SECRET is a project-wide edge function secret) rather than retyping it.

select cron.schedule(
  'notify-coverage-gaps-daily',
  '0 7 * * *',
  format(
    $cmd$
    select net.http_post(
      url     := 'https://pkjlnjsswoadftkseffo.supabase.co/functions/v1/notify-coverage-gaps',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', %L),
      body    := '{}'::jsonb
    );
    $cmd$,
    (regexp_match(
      (select command from cron.job where jobname = 'weekly-email-heartbeat'),
      'x-cron-secret"\s*:\s*"([^"]+)"'
    ))[1]
  )
);
