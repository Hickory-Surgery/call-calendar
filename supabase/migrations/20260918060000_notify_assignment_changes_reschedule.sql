-- Move notify-assignment-changes-daily from 09:00 UTC to 08:00 UTC (4am EST / 3am EDT),
-- to keep it clear of the 5am-local window it lands in during daylight saving — someone
-- could plausibly be making changes that early.
--
-- Run in the SQL editor. Reuses the same secret already stored on weekly-email-heartbeat
-- (CRON_SECRET is a project-wide edge function secret) rather than retyping it.

select cron.unschedule('notify-assignment-changes-daily');

select cron.schedule(
  'notify-assignment-changes-daily',
  '0 8 * * *',
  format(
    $cmd$
    select net.http_post(
      url     := 'https://pkjlnjsswoadftkseffo.supabase.co/functions/v1/notify-assignment-changes',
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
