-- 0154_attendance_geo.sql
-- Soft punch-geofence: per-punch GPS location on attendance_records, so a clock
-- in/out can be flagged when it lands outside the factory radius.
--
-- Columns are snake_case (the d1-compat adapter translates the camelCase the app
-- writes — clockInLat — to clock_in_lat). The punch route ALSO self-applies these
-- at runtime via ensurePendingMigrations, so a re-run here is a harmless no-op.
--
-- Additive + nullable: a punch from a phone that denies / can't get location
-- simply leaves them NULL. SOFT — location is recorded for review, never blocks
-- the punch, never touches payroll.
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_in_lat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_in_lng DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_out_lat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_out_lng DOUBLE PRECISION;
