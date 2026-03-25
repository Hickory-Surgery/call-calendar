-- Backfill daily_coverage.day_call_id from existing assignments.
-- Logic mirrors persistDailyCoverage() in the frontend:
--   exception person wins; otherwise first HOSP person.
-- Weekend note: assignments stores both days under Saturday's date.
--   Saturday day call = am='hosp' or exception.
--   Sunday day call   = pm='hosp' (no exception flag for Sunday slot).

-- ── Weekdays (Mon–Fri): exception wins, then am OR pm hosp ───────────────

-- Exception person → weekday
insert into daily_coverage (date, day_call_id, updated_at)
select distinct on (a.date) a.date, a.person_id, now()
from   assignments a
where  extract(dow from a.date) between 1 and 5
  and  a.exception = true
order  by a.date, a.person_id
on conflict (date) do update
  set day_call_id = excluded.day_call_id,
      updated_at  = excluded.updated_at;

-- HOSP person → weekday (only if no exception already written)
insert into daily_coverage (date, day_call_id, updated_at)
select distinct on (a.date) a.date, a.person_id, now()
from   assignments a
where  extract(dow from a.date) between 1 and 5
  and  (a.am = 'hosp' or a.pm = 'hosp')
  and  not exists (
         select 1 from assignments a2
         where  a2.date = a.date and a2.exception = true
       )
order  by a.date, a.person_id
on conflict (date) do update
  set day_call_id = excluded.day_call_id,
      updated_at  = excluded.updated_at
where  daily_coverage.day_call_id is null;

-- ── Saturday (dow=6): exception wins, then am='hosp' ────────────────────

insert into daily_coverage (date, day_call_id, updated_at)
select distinct on (a.date) a.date, a.person_id, now()
from   assignments a
where  extract(dow from a.date) = 6
  and  a.exception = true
order  by a.date, a.person_id
on conflict (date) do update
  set day_call_id = excluded.day_call_id,
      updated_at  = excluded.updated_at;

insert into daily_coverage (date, day_call_id, updated_at)
select distinct on (a.date) a.date, a.person_id, now()
from   assignments a
where  extract(dow from a.date) = 6
  and  a.am = 'hosp'
  and  not exists (
         select 1 from assignments a2
         where  a2.date = a.date and a2.exception = true
       )
order  by a.date, a.person_id
on conflict (date) do update
  set day_call_id = excluded.day_call_id,
      updated_at  = excluded.updated_at
where  daily_coverage.day_call_id is null;

-- ── Sunday (stored under Saturday row, pm slot): pm='hosp' ──────────────
-- Sunday date = Saturday date + 1 day.

insert into daily_coverage (date, day_call_id, updated_at)
select distinct on (a.date) (a.date + 1)::date, a.person_id, now()
from   assignments a
where  extract(dow from a.date) = 6
  and  a.pm = 'hosp'
order  by a.date, a.person_id
on conflict (date) do update
  set day_call_id = excluded.day_call_id,
      updated_at  = excluded.updated_at
where  daily_coverage.day_call_id is null;
