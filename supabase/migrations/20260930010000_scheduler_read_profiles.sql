-- Lets schedulers read all profiles (email + role), so the weekly-email recipient box in
-- Settings → Data can suggest existing user accounts. Previously only admins could (policy
-- "admins can read profiles"); everyone else could read only their own row (profiles_read).
-- Note this exposes every user's email and role to scheduler accounts through the API too.
--
-- Uses get_my_role() rather than selecting from profiles inside the policy, which would
-- recurse. get_my_role() and is_admin() exist in production but were created outside tracked
-- migrations (same drift as the profiles policies themselves) — a rebuild from migrations alone
-- would fail on this statement until those functions exist.
drop policy if exists "schedulers can read profiles" on profiles;
create policy "schedulers can read profiles"
  on profiles for select
  using (get_my_role() = 'scheduler');
