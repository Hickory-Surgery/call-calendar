-- Audit trail for changes to staff.user_id / staff.email (who receives assignment-change
-- emails). On 2026-10 these were found silently cleared for five staff with no record of
-- when or by whom; this table makes that visible next time.
--
-- Deliberately separate from audit_log: notify-assignment-changes and the Audit Log tab
-- both read audit_log assuming every row is an assignments row. Only the relevant columns
-- are stored (not to_jsonb(row)) so staff.feed_token never lands in an audit table.
-- changed_by is null when the change came from the SQL editor / service role rather than
-- the app, which itself helps tell the two apart.

create table if not exists staff_link_audit (
  id           bigserial primary key,
  changed_at   timestamptz not null default now(),
  changed_by   uuid references auth.users(id) on delete set null,
  staff_id     uuid not null,
  short_name   text,
  old_user_id  uuid,
  new_user_id  uuid,
  old_email    text,
  new_email    text
);

alter table staff_link_audit enable row level security;

create policy "Admins can read staff_link_audit"
  on staff_link_audit for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

create or replace function audit_staff_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into staff_link_audit (changed_by, staff_id, short_name, old_user_id, new_user_id, old_email, new_email)
  values (auth.uid(), new.id, new.short_name, old.user_id, new.user_id, old.email, new.email);
  return new;
end;
$$;

create or replace trigger staff_link_audit_trg
  after update on staff
  for each row
  when (old.user_id is distinct from new.user_id or old.email is distinct from new.email)
  execute function audit_staff_link();
