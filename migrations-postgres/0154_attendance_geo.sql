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
-- CORRECTED 2026-06-11: the runtime self-apply (ensureAttendanceGeo) runs its
-- DDL through the d1-compat adapter, whose identifier rewrite only knows the
-- static rename map — so on PROD these columns exist FOLDED-LOWERCASE
-- (clockinlat, ...), NOT snake_case. This file now matches reality so a tool
-- apply is a true no-op instead of creating duplicate snake_case columns.
-- Reads use dual-key fallbacks (see attendance.ts rowToAttendance).
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockinlat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockinlng DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockoutlat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockoutlng DOUBLE PRECISION;
