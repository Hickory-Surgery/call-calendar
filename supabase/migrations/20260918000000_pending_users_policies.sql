-- pending_users had RLS enabled with no policies in any tracked migration,
-- silently blocking the admin Users panel's Pending list (index.html fetchProfiles)
-- and the delete-after-approve step (index.html renderUsersList approve handler).
-- Idempotent so it's safe to apply regardless of any policy already set out-of-band.

drop policy if exists "Admins can read pending_users" on pending_users;
create policy "Admins can read pending_users"
  on pending_users for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

drop policy if exists "Admins can delete pending_users" on pending_users;
create policy "Admins can delete pending_users"
  on pending_users for delete
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );
