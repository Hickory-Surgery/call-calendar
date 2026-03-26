-- Replace single updated_by-based isManual flag with per-field manual flags.
-- day_call_manual: true only when day_call_id was explicitly set via the coverage panel
-- bari_manual:     true only when bari_id was explicitly set via the coverage panel
--
-- Backfill rows had updated_by = NULL, so their manual flags stay false.
-- Previous coverage panel saves (updated_by IS NOT NULL) with bari_id set are treated as bari-manual.
-- day_call_manual is conservatively left false for historical data.

alter table daily_coverage
  add column if not exists day_call_manual boolean not null default false,
  add column if not exists bari_manual     boolean not null default false;

update daily_coverage
  set bari_manual = true
  where updated_by is not null and bari_id is not null;
