-- ============================================================================
-- HOOKKA ERP — Payroll runs
--
-- One row per (worker, period) with computed salary + OT + statutory
-- breakdown in sen. `period` is "YYYY-MM". Eligibility is derived at run-time
-- from the `workers` table (status = 'ACTIVE').
--
-- Drops the older stub table first. camelCase columns; snake_case timestamps.
-- ============================================================================

DROP TABLE IF EXISTS payroll_records;
DROP INDEX IF EXISTS idx_payroll_workerId;

CREATE TABLE payroll_records (
  id                  TEXT PRIMARY KEY,
  workerId            TEXT NOT NULL,
  workerName          TEXT NOT NULL DEFAULT '',
  period              TEXT NOT NULL,                  -- YYYY-MM
  basicSalarySen      INTEGER NOT NULL DEFAULT 0,
  workingDays         INTEGER NOT NULL DEFAULT 26,
  otHoursWeekday      INTEGER NOT NULL DEFAULT 0,
  otHoursSunday       INTEGER NOT NULL DEFAULT 0,
  otHoursHoliday      INTEGER NOT NULL DEFAULT 0,
  otAmountSen         INTEGER NOT NULL DEFAULT 0,
  grossSalarySen      INTEGER NOT NULL DEFAULT 0,
  epfEmployeeSen      INTEGER NOT NULL DEFAULT 0,
  epfEmployerSen      INTEGER NOT NULL DEFAULT 0,
  socsoEmployeeSen    INTEGER NOT NULL DEFAULT 0,
  socsoEmployerSen    INTEGER NOT NULL DEFAULT 0,
  eisEmployeeSen      INTEGER NOT NULL DEFAULT 0,
  eisEmployerSen      INTEGER NOT NULL DEFAULT 0,
  pcbSen              INTEGER NOT NULL DEFAULT 0,
  totalDeductionsSen  INTEGER NOT NULL DEFAULT 0,
  netPaySen           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | APPROVED | PAID
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workerId, period)
);

CREATE INDEX idx_payroll_period   ON payroll_records(period);
CREATE INDEX idx_payroll_workerId ON payroll_records(workerId);
CREATE INDEX idx_payroll_status   ON payroll_records(status);
