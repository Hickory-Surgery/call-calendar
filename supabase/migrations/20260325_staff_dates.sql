-- Add start and stop month boundaries to staff members.
-- start_date: staff appears on calendar from this month onward (inclusive).
-- stop_date:  staff disappears after this month (shown through stop month, hidden the month after).
-- Stored as the first day of the relevant month (YYYY-MM-01); only the year+month matter.

alter table staff
  add column if not exists start_date date,
  add column if not exists stop_date  date;
