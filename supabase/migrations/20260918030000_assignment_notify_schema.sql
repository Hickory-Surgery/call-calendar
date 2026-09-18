-- Schema for the assignment-change notification feature: emails a staff member when
-- an on-call/backup/bari assignment involving them changes after initial entry.

-- Which login account a staff member corresponds to, for looking up their email.
-- Staff and app accounts (profiles/auth.users) are separate identity spaces — not
-- every staff member necessarily has a login, and short_name isn't reliably
-- correlated with the account email, so this needs an explicit admin-set link
-- rather than being inferred.
alter table staff
  add column if not exists user_id uuid references auth.users(id) on delete set null;

-- Last-known resolved backup (day-call) and bari person per date, maintained by the
-- notify-assignment-changes job itself. daily_coverage holds only the CURRENT resolved
-- value with no history and no audit trail, so this is the only record of "what did
-- this resolve to last time we checked" needed to detect a change.
create table if not exists assignment_notify_snapshot (
  date        date primary key,
  backup_id   uuid references staff(id) on delete set null,
  bari_id     uuid references staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- Internal bookkeeping only, written and read solely by the notify job via the
-- service role key — no client ever needs to read this.
alter table assignment_notify_snapshot enable row level security;

-- High-water mark for incrementally scanning audit_log for on-call changes.
alter table company_info
  add column if not exists assignment_notify_last_run timestamptz;
