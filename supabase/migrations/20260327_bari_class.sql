-- Add bari_class_id column to daily_coverage for the "Bari Class" coverage override.
-- This is a purely manual field (no computed fallback) — always null until explicitly set.

alter table daily_coverage
  add column if not exists bari_class_id   uuid references staff(id) on delete set null,
  add column if not exists bari_class_manual bool not null default false;
