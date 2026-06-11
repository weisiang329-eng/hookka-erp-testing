-- 0156_attendance_photo.sql
-- Punch selfie (anti-buddy-punching): store the photo a worker takes when they
-- clock in / out on their phone, so the office can confirm it's really them.
--
-- Columns are snake_case (the d1-compat adapter translates the camelCase the app
-- writes — clockInPhoto — to clock_in_photo). The punch route ALSO self-applies
-- these at runtime via ensureAttendanceGeo, so a re-run here is a harmless no-op.
--
-- Stored as a compressed JPEG data URL (the worker app shrinks the shot to
-- ~640px before sending). Additive + nullable: an office-keyed row, a legacy
-- punch, or a phone with no camera simply leaves them NULL — the attendance view
-- shows "No photo" so a skip is visible. SOFT — never blocks the punch.
-- CORRECTED 2026-06-11: the runtime self-apply runs through the d1-compat
-- adapter (static rename map only) → on PROD these columns are FOLDED-LOWERCASE
-- (clockinphoto / clockoutphoto), not snake_case. File matches reality; reads
-- use dual-key fallbacks (attendance.ts).
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockinphoto TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockoutphoto TEXT;
