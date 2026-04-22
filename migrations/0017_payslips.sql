-- ============================================================================
-- HOOKKA ERP — Payslips (Malaysian statutory breakdown)
--
-- One row per (employee, period). Similar to payroll_records but with the
-- full display breakdown used by the payslip PDF: hourlyRate, OT by category,
-- allowances, and bank account.
--
-- Drops the prior table (which used a mixed snake_case layout) first.
-- ============================================================================

DROP TABLE IF EXISTS payslips;
DROP INDEX IF EXISTS idx_payslips_employee;
DROP INDEX IF EXISTS idx_payslip_employeeId;

CREATE TABLE payslips (
  id                  TEXT PRIMARY KEY,
  employeeId          TEXT NOT NULL,
  employeeName        TEXT NOT NULL DEFAULT '',
  employeeNo          TEXT NOT NULL DEFAULT '',
  departmentCode      TEXT NOT NULL DEFAULT '',
  period              TEXT NOT NULL,                  -- YYYY-MM
  basicSalarySen      INTEGER NOT NULL DEFAULT 0,
  workingDays         INTEGER NOT NULL DEFAULT 26,
  otWeekdayHours      INTEGER NOT NULL DEFAULT 0,
  otSundayHours       INTEGER NOT NULL DEFAULT 0,
  otPhHours           INTEGER NOT NULL DEFAULT 0,
  hourlyRateSen       INTEGER NOT NULL DEFAULT 0,
  otWeekdayAmtSen     INTEGER NOT NULL DEFAULT 0,
  otSundayAmtSen      INTEGER NOT NULL DEFAULT 0,
  otPhAmtSen          INTEGER NOT NULL DEFAULT 0,
  totalOtSen          INTEGER NOT NULL DEFAULT 0,
  allowancesSen       INTEGER NOT NULL DEFAULT 0,
  grossPaySen         INTEGER NOT NULL DEFAULT 0,
  epfEmployeeSen      INTEGER NOT NULL DEFAULT 0,
  epfEmployerSen      INTEGER NOT NULL DEFAULT 0,
  socsoEmployeeSen    INTEGER NOT NULL DEFAULT 0,
  socsoEmployerSen    INTEGER NOT NULL DEFAULT 0,
  eisEmployeeSen      INTEGER NOT NULL DEFAULT 0,
  eisEmployerSen      INTEGER NOT NULL DEFAULT 0,
  pcbSen              INTEGER NOT NULL DEFAULT 0,
  totalDeductionsSen  INTEGER NOT NULL DEFAULT 0,
  netPaySen           INTEGER NOT NULL DEFAULT 0,
  bankAccount         TEXT NOT NULL DEFAULT '',
  payrollRunId        TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | APPROVED | PAID
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (employeeId, period)
);

CREATE INDEX idx_payslips_period    ON payslips(period);
CREATE INDEX idx_payslips_employee  ON payslips(employeeId);
CREATE INDEX idx_payslips_status    ON payslips(status);
