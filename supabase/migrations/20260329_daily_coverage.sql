-- Rename coverage_overrides → daily_coverage and backup_id → day_call_id.
-- This table now holds the authoritative computed-or-manual per-day assignments
-- for day call and bari call, written by the app on every assignment save.
--
-- Also migrates bari_call weekly designees into daily_coverage.bari_id for
-- all 7 days of each designee week, then drops the bari_call table.

-- 1. Rename table and column
alter table coverage_overrides rename to daily_coverage;
alter table daily_coverage rename column backup_id to day_call_id;

-- 2. Enable replica identity so realtime DELETE events carry old row data
alter table daily_coverage replica identity full;

-- 3. Seed bari_id from bari_call weekly designees for days not already overridden
insert into daily_coverage (date, bari_id, updated_at)
select (bc.week_start + i)::date, bc.person_id, now()
from   bari_call bc
cross  join generate_series(0, 6) as gs(i)
on conflict (date) do update
  set bari_id    = excluded.bari_id,
      updated_at = excluded.updated_at
where daily_coverage.bari_id is null;

-- 4. Drop the now-superseded weekly table
drop table bari_call;
