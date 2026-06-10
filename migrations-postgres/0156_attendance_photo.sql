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
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_in_photo TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clock_out_photo TEXT;
