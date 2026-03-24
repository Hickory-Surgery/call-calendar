-- Stores email addresses that receive the automated weekly schedule email.
-- Managed by schedulers and admins via the Settings → Data tab.

create table if not exists email_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  label      text not null default '',
  created_at timestamptz not null default now()
);

alter table email_recipients enable row level security;

-- Schedulers and admins can read and manage recipients
create policy "Editors can read email_recipients"
  on email_recipients for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );

create policy "Editors can insert email_recipients"
  on email_recipients for insert
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );

create policy "Editors can delete email_recipients"
  on email_recipients for delete
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );
