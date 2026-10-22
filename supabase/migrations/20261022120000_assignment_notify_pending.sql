-- Queue of assignment-change notifications that couldn't be delivered (staff member has no
-- email on file, or Resend rejected/failed the send). notify-assignment-changes retries these
-- on every run until delivered or the event's date has passed, and reminds the office contact
-- (or all admins) while any are outstanding. last_alerted_at throttles those reminders.
create table if not exists assignment_notify_pending (
  id               bigserial primary key,
  person           text not null,          -- staff.short_name
  event_date       date not null,
  event            jsonb not null,         -- the NotifyEvent, as built by the job
  created_at       timestamptz not null default now(),
  last_alerted_at  timestamptz
);

-- Internal bookkeeping, read and written solely by the notify job via the service role key.
alter table assignment_notify_pending enable row level security;

grant select, insert, update, delete on assignment_notify_pending to service_role;
grant usage, select on sequence assignment_notify_pending_id_seq to service_role;
