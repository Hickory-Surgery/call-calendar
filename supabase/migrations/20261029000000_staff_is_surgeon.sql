-- Whether a staff member is a surgeon who can claim OR time. notify-assignment-changes
-- sends the "OR time now open" alert only to active staff with this set and an email on
-- file. Defaults to true so a newly added person is included; non-surgeons are unticked
-- in Settings -> Staff.
alter table staff
  add column if not exists is_surgeon boolean not null default true;

-- JL isn't a surgeon and never has F-surg/C-surg assignments.
update staff set is_surgeon = false where short_name = 'JL';
