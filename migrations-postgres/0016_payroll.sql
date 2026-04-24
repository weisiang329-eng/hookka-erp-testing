-- ============================================================================
-- HOOKKA ERP — Payroll runs
--
-- One row per (worker, period) with computed salary + OT + statutory
-- breakdown in sen. `period` is "YYYY-MM". Eligibility is derived at run-time
-- from the `workers` table (status = 'ACTIVE').
--
-- Drops the older stub table first. camelCase columns; snake_case timestamps.
-- ============================================================================

DROP TABLE IF EXISTS payroll_records CASCADE;
DROP INDEX IF EXISTS idx_payroll_worker_id;

CREATE TABLE payroll_records (
  id                  TEXT PRIMARY KEY,
  worker_id            TEXT NOT NULL,
  worker_name          TEXT NOT NULL DEFAULT '',
  period              TEXT NOT NULL,                  -- YYYY-MM
  basic_salary_sen      INTEGER NOT NULL DEFAULT 0,
  working_days         INTEGER NOT NULL DEFAULT 26,
  ot_hours_weekday      INTEGER NOT NULL DEFAULT 0,
  ot_hours_sunday       INTEGER NOT NULL DEFAULT 0,
  ot_hours_holiday      INTEGER NOT NULL DEFAULT 0,
  ot_amount_sen         INTEGER NOT NULL DEFAULT 0,
  gross_salary_sen      INTEGER NOT NULL DEFAULT 0,
  epf_employee_sen      INTEGER NOT NULL DEFAULT 0,
  epf_employer_sen      INTEGER NOT NULL DEFAULT 0,
  socso_employee_sen    INTEGER NOT NULL DEFAULT 0,
  socso_employer_sen    INTEGER NOT NULL DEFAULT 0,
  eis_employee_sen      INTEGER NOT NULL DEFAULT 0,
  eis_employer_sen      INTEGER NOT NULL DEFAULT 0,
  pcb_sen              INTEGER NOT NULL DEFAULT 0,
  total_deductions_sen  INTEGER NOT NULL DEFAULT 0,
  net_pay_sen           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | APPROVED | PAID
  created_at          TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at          TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE (worker_id, period)
);

CREATE INDEX idx_payroll_period   ON payroll_records(period);
CREATE INDEX idx_payroll_worker_id ON payroll_records(worker_id);
CREATE INDEX idx_payroll_status   ON payroll_records(status);
