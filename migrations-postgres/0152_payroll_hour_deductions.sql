-- 0152_payroll_hour_deductions.sql
-- Per-worker, per-day deduction of unworked hours, set from the Labor Cost
-- "Under-recorded hours" review. When a factory worker came but logged FEWER
-- hours than a full day and that short time is NOT to be paid (it was neither a
-- data-entry miss to backfill, nor idle-but-paid standby), the owner docks those
-- hours here. Payroll subtracts hours x the worker's div-working-days hourly
-- rate (basic_salary_sen / (working_days_per_month - public holidays) /
-- working_hours_per_day) from basic earned, closing the under-recorded gap so
-- Payroll and Labor Cost tally.
--
--   worker_id  -- FK to workers; cascade-delete with the worker.
--   date       -- YYYY-MM-DD, the working day the hours are docked from.
--   hours      -- decimal hours to dock (DOUBLE PRECISION, matches
--                 working_hour_entries.hours so 4.5h etc. work).
--   note       -- optional free-text reason.
--
-- One row per (worker_id, date) -- re-docking the same day overwrites via upsert.
-- Idempotent (IF NOT EXISTS) so a re-run is a no-op.
CREATE TABLE IF NOT EXISTS payroll_hour_deductions (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (NOW()),
  updated_at TEXT NOT NULL DEFAULT (NOW()),
  UNIQUE (worker_id, date),
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payroll_hour_deductions_date
  ON payroll_hour_deductions(date);
