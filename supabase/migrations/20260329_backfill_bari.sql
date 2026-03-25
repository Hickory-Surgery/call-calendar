-- Backfill daily_coverage.bari_id from existing assignments + staff.is_bariatric.
-- Logic: on-call person if bari+, else day-call person if bari+.
-- Does NOT overwrite existing non-null bari_id (preserves manual overrides).

-- Build on-call person per calendar date (weekdays + split sat/sun weekend rows)
with oncall_per_day as (
  -- Mon–Fri: either oncall slot counts
  select a.date as cal_date, a.person_id
  from   assignments a
  where  extract(dow from a.date) between 1 and 5
    and  (a.oncall_am != 'none' or a.oncall_pm != 'none')
  union all
  -- Saturday: am slot
  select a.date, a.person_id
  from   assignments a
  where  extract(dow from a.date) = 6 and a.oncall_am != 'none'
  union all
  -- Sunday: pm slot stored under Saturday row
  select (a.date + 1)::date, a.person_id
  from   assignments a
  where  extract(dow from a.date) = 6 and a.oncall_pm != 'none'
),
-- One on-call person per date (deterministic)
oncall_primary as (
  select distinct on (cal_date) cal_date, person_id
  from   oncall_per_day
  order  by cal_date, person_id
),
-- Compute expected bari_id: on-call if bari+, else day-call if bari+
bari_result as (
  select
    op.cal_date                                           as date,
    coalesce(
      case when s_oc.is_bariatric then op.person_id end,
      case when s_dc.is_bariatric then dc.day_call_id end
    )                                                     as bari_id
  from      oncall_primary           op
  join      staff                    s_oc on s_oc.id = op.person_id
  left join daily_coverage           dc   on dc.date  = op.cal_date
  left join staff                    s_dc on s_dc.id  = dc.day_call_id
)
insert into daily_coverage (date, bari_id, updated_at)
select date, bari_id, now()
from   bari_result
where  bari_id is not null
on conflict (date) do update
  set bari_id    = excluded.bari_id,
      updated_at = excluded.updated_at
where  daily_coverage.bari_id is null;   -- preserve manual overrides
