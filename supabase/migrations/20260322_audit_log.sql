-- Audit log for assignments table
-- Records every INSERT, UPDATE, and DELETE with who made the change and what changed.

create table if not exists audit_log (
  id          bigserial primary key,
  changed_at  timestamptz not null default now(),
  changed_by  uuid references auth.users(id) on delete set null,
  operation   text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  row_id      uuid not null,           -- assignments.id
  old_row     jsonb,                   -- null on INSERT
  new_row     jsonb                    -- null on DELETE
);

-- Only admins/service role can read audit_log; nobody can modify it via the API.
alter table audit_log enable row level security;

create policy "Admins can read audit_log"
  on audit_log for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

-- Trigger function
create or replace function audit_assignments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (changed_by, operation, row_id, old_row, new_row)
  values (
    auth.uid(),
    tg_op,
    coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create or replace trigger assignments_audit
  after insert or update or delete on assignments
  for each row execute function audit_assignments();
