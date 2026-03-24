-- Manual overrides for day-call backup and bariatric backup per calendar date.
-- When set, override values take priority over the algorithmic assignment.
-- Used by schedulers/admins to handle gaps, known absences, or special circumstances.

create table if not exists coverage_overrides (
  date        date primary key,
  backup_id   uuid references staff(id) on delete set null,
  bari_id     uuid references staff(id) on delete set null,
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

alter table coverage_overrides enable row level security;

create policy "Editors can read coverage_overrides"
  on coverage_overrides for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );

create policy "Editors can insert coverage_overrides"
  on coverage_overrides for insert
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );

create policy "Editors can update coverage_overrides"
  on coverage_overrides for update
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );

create policy "Editors can delete coverage_overrides"
  on coverage_overrides for delete
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('scheduler', 'admin')
    )
  );
