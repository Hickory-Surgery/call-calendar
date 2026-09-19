-- Dedup marker for the admin coverage-gap alert (notify-coverage-gaps), same pattern
-- as company_info.email_last_sent / assignment_notify_last_run.
alter table company_info
  add column if not exists admin_alert_last_sent timestamptz;
