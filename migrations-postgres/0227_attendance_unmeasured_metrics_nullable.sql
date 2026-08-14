-- ---------------------------------------------------------------------------
-- 0227 — attendance_records: let "not measured" be expressible.
--
-- BUG-2026-08-13-103 (bug class C15 — a figure that reads as measured, and is
-- not).
--
-- 0018_attendance.sql declared:
--
--     production_time_minutes INTEGER NOT NULL DEFAULT 0,
--     efficiency_pct          INTEGER NOT NULL DEFAULT 0,
--
-- and the two punch routes filled them at clock-out with
--
--     production_time_minutes = round(working_minutes * 0.85)
--     efficiency_pct          = production_time_minutes / standard_minutes * 100
--
-- Production time was NEVER measured. It is a fixed 85% of the clock time.
-- Measured on prod for August 2026: 180,928 / 212,850 = 0.85005 — the constant
-- showing through. `dept_breakdown` published the same number again as a
-- per-department split, under an empty product code.
--
-- The routes now leave all three unwritten. This migration makes that
-- expressible: NOT NULL forced every row to carry a number, and a stored 0
-- would be the same defect one step quieter — "zero production time" is a
-- claim, "unknown" is the truth.
--
-- Idempotent: DROP NOT NULL / DROP DEFAULT on a column that already permits
-- NULL or has no default is a no-op in Postgres. The same statements run at
-- runtime from src/api/routes/attendance.ts (`ensureAttendanceMetricsNullable`)
-- because migrations are inert on deploy in this repo — see CLAUDE.md.
--
-- DELIBERATELY NOT INCLUDED: an UPDATE that NULLs the ~2,780 historic rows.
-- Every one of those values is fabricated and none is worth keeping, but
-- erasing them is irreversible and is the owner's call. It is not needed for
-- correctness either: the read path (`rowToAttendance`) publishes null and []
-- unconditionally, so no historic value can reach a screen, an export, or the
-- assistant. If the owner wants the column physically cleaned:
--
--     UPDATE attendance_records
--        SET production_time_minutes = NULL,
--            efficiency_pct          = NULL,
--            dept_breakdown          = '[]';
-- ---------------------------------------------------------------------------

ALTER TABLE attendance_records ALTER COLUMN production_time_minutes DROP NOT NULL;
ALTER TABLE attendance_records ALTER COLUMN production_time_minutes DROP DEFAULT;
ALTER TABLE attendance_records ALTER COLUMN efficiency_pct          DROP NOT NULL;
ALTER TABLE attendance_records ALTER COLUMN efficiency_pct          DROP DEFAULT;
