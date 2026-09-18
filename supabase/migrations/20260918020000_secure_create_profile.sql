-- create_profile had no caller-authorization check and was granted EXECUTE to anon/PUBLIC,
-- so any caller — including unauthenticated ones, using only the public anon key — could set
-- any existing auth user's profiles.role to anything, including 'admin'. This bypassed the
-- entire admin-approval workflow in Settings -> Users. Never captured in a tracked migration
-- until now (see project_untracked_schema_drift memory) — replacing the vulnerable version
-- with a fixed one, not backfilling it as-is.

create or replace function public.create_profile(user_email text, user_role text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  user_id uuid;
begin
  if not exists (
    select 1 from public.profiles
    where public.profiles.id = auth.uid()
      and public.profiles.role = 'admin'
  ) then
    raise exception 'Only admins can call create_profile';
  end if;

  select id into user_id from auth.users where email = user_email;
  if user_id is null then
    raise exception 'No user found with email %. They must sign in once first.', user_email;
  end if;

  insert into public.profiles (id, email, role) values (user_id, user_email, user_role)
    on conflict (id) do update set role = user_role, email = user_email;
end;
$function$;

revoke execute on function public.create_profile(text, text) from public;
revoke execute on function public.create_profile(text, text) from anon;
grant execute on function public.create_profile(text, text) to authenticated;
grant execute on function public.create_profile(text, text) to service_role;
