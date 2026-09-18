-- Not every staff member has a login account. staff.user_id (added in
-- 20260918030000) covers the common case; this is a manually-entered fallback
-- for a staff member who doesn't have one, so they can still receive
-- assignment-change notifications. Linked account takes priority when both exist.
alter table staff
  add column if not exists email text;
