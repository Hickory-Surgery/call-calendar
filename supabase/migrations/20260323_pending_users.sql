-- Tracks users who authenticated but have no profile yet.
-- Used to ensure admins are notified exactly once per new user.

create table if not exists pending_users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  requested_at timestamptz not null default now(),
  notified_at  timestamptz
);

-- No public access; service role only.
alter table pending_users enable row level security;
