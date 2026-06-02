-- 0144_workers_hours_decimal.sql
-- Allow fractional standard hours/day per worker (e.g. 7.5).
--
-- Why: some staff work a 7.5-hour standard day. workers.working_hours_per_day
-- was INTEGER, so a 7.5 entry from Employee Master was rounded to 8 on write —
-- silently corrupting that worker's OT threshold and hourly rate. The frontend
-- already accepts decimals (step 0.5); this widens the column to match.
--
-- DOUBLE PRECISION mirrors workers.ot_multiplier (migration 0061), which is the
-- other per-worker decimal and is returned by postgres.js as a JS number, so
-- the labor engine keeps doing plain arithmetic with no string coercion.
--
-- The departments.working_hours_per_day column is left INTEGER on purpose — it
-- is only a per-department default; the per-worker value is the one that drives
-- pay and is the only one the operator types a half-hour into.

ALTER TABLE workers
  ALTER COLUMN working_hours_per_day TYPE DOUBLE PRECISION
  USING working_hours_per_day::double precision;
