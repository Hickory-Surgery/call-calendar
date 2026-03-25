-- Add email schedule fields to company_info.
-- email_day: 0=Sun … 6=Sat (day of week to send the weekly email)
-- email_time: time of day in UTC to send (e.g. '13:00')
-- email_last_sent: timestamp of the last successful send (for deduplication)

alter table company_info
  add column if not exists email_day   int  check (email_day between 0 and 6),
  add column if not exists email_time  time,
  add column if not exists email_last_sent timestamptz;
