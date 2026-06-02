-- 0143_workers_resignation.sql
-- Adds resignation tracking to workers.
--
-- Why: a resigned employee must stop being paid from their resignation date
-- onward. Before this, the only "off" state was status = 'INACTIVE' (the soft
-- delete), which carries no date and is also used for other deactivations.
--
-- New model:
--   - status may now take the value 'RESIGNED' (status is free TEXT; no enum
--     change needed). 'ACTIVE' workers are paid; 'RESIGNED' workers are paid
--     only for the month containing their resignedAt date (prorated by the
--     existing absence math for the days after they left), and excluded from
--     every later month's payroll generation.
--   - resigned_at (YYYY-MM-DD) records the last day of employment. NULL for
--     everyone still employed.
--
-- Payroll generation (src/api/routes/payslips.ts) includes a RESIGNED worker
-- only when resigned_at falls inside the period being generated, so their
-- final (partial) month is still paid and no later month is.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS resigned_at text;
