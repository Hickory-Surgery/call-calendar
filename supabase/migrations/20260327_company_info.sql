-- Single-row table storing practice contact information used in emails and UI.
-- Enforced single row via check (id = 1); upsert on id=1 to update.

create table company_info (
  id                      int primary key default 1 check (id = 1),
  name                    text,
  address                 text,
  phone                   text,
  fax                     text,
  office_manager          text,
  scheduling_coordinator  text,
  logo_url                text,
  updated_at              timestamptz not null default now()
);

-- Seed the single row so upsert never needs INSERT privilege from the app
insert into company_info (id) values (1) on conflict do nothing;

alter table company_info enable row level security;

create policy "Authenticated users can read company_info"
  on company_info for select
  using (auth.uid() is not null);

create policy "Admins can update company_info"
  on company_info for update
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );
