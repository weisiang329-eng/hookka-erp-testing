-- 0155_payroll_hour_deduction_source.sql
-- Distinguish how a dock was created: by the owner (MANUAL, from the Labor Cost
-- "Under-recorded hours" review) vs automatically from a punch (AUTO, when a
-- worker's clock in/out shows they came late past the 10-min grace and/or worked
-- short of a full 9-hour day). The auto path NEVER overrides a MANUAL dock, and
-- the owner can still Undo any AUTO dock before approving the month — so this
-- column is the load-bearing flag that keeps the owner's manual decisions safe.
--
-- Additive + IF NOT EXISTS + DEFAULT 'MANUAL' so every existing dock (all of
-- which were created by the owner) is correctly back-tagged MANUAL, and a re-run
-- is a no-op. Applied at runtime via ensureDeductionSourceColumn() (the same
-- ensurePendingMigrations pattern the geofence columns use) so it lands without a
-- deploy-time migration step; this file is the durable record.
ALTER TABLE payroll_hour_deductions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL';
