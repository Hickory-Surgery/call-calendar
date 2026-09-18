-- "Editors can read coverage_overrides" (named for this table's original name,
-- before the coverage_overrides → daily_coverage rename in 20260329030000) is now
-- fully shadowed by "Public can read daily_coverage" (using (true), added in
-- 20260509000000_daily_coverage_public_read.sql) — permissive SELECT policies OR
-- together, so the editors-only policy is a no-op. Drop it as cleanup.
-- Insert/update/delete editor policies are untouched — those aren't shadowed.

drop policy if exists "Editors can read coverage_overrides" on daily_coverage;
