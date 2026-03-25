-- Backfill daily_coverage.day_call_id for Saturday and Sunday dates
-- where no HOSP assignment exists, using the preceding Friday's HOSP person as fallback.
-- This mirrors the backupPersonForDay() weekend fallback logic in the frontend.

-- Saturday: use Friday's HOSP if no Saturday am='hosp' and no exception
update daily_coverage dc
set day_call_id = fri.person_id, updated_at = now()
from assignments fri
where dc.day_call_id is null
  and extract(dow from dc.date) = 6          -- Saturday
  and fri.date = dc.date - 1                 -- preceding Friday
  and (fri.am = 'hosp' or fri.pm = 'hosp')
  and not exists (
    select 1 from assignments sat
    where sat.date = dc.date
      and (sat.am = 'hosp' or sat.exception = true)
  );

-- Sunday: use Friday's HOSP if no Sunday pm='hosp' (stored in Saturday row)
update daily_coverage dc
set day_call_id = fri.person_id, updated_at = now()
from assignments fri
where dc.day_call_id is null
  and extract(dow from dc.date) = 0          -- Sunday
  and fri.date = dc.date - 2                 -- preceding Friday (Sunday - 2 = Friday)
  and (fri.am = 'hosp' or fri.pm = 'hosp')
  and not exists (
    select 1 from assignments sat
    where sat.date = dc.date - 1             -- Saturday row
      and sat.pm = 'hosp'
  );

-- Insert Saturday rows that have no daily_coverage entry yet (weekend with no HOSP on Sat/Sun,
-- but Friday had HOSP — and a bari+ person was on call so a bari row may already exist)
insert into daily_coverage (date, day_call_id, updated_at)
select a_sat.date, a_fri.person_id, now()
from   assignments a_sat
join   assignments a_fri on a_fri.date = a_sat.date - 1
                         and (a_fri.am = 'hosp' or a_fri.pm = 'hosp')
where  extract(dow from a_sat.date) = 6
  and  not exists (
    select 1 from assignments x
    where  x.date = a_sat.date and (x.am = 'hosp' or x.exception = true)
  )
  and  not exists (select 1 from daily_coverage dc where dc.date = a_sat.date)
on conflict (date) do nothing;

-- Insert Sunday rows similarly
insert into daily_coverage (date, day_call_id, updated_at)
select (a_sat.date + 1)::date, a_fri.person_id, now()
from   assignments a_sat
join   assignments a_fri on a_fri.date = a_sat.date - 1
                         and (a_fri.am = 'hosp' or a_fri.pm = 'hosp')
where  extract(dow from a_sat.date) = 6
  and  not exists (select 1 from assignments x where x.date = a_sat.date and x.pm = 'hosp')
  and  not exists (select 1 from daily_coverage dc where dc.date = (a_sat.date + 1)::date)
on conflict (date) do nothing;
