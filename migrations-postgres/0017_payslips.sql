-- ============================================================================
-- HOOKKA ERP — Payslips (Malaysian statutory breakdown)
--
-- One row per (employee, period). Similar to payroll_records but with the
-- full display breakdown used by the payslip PDF: hourlyRate, OT by category,
-- allowances, and bank account.
--
-- Drops the prior table (which used a mixed snake_case layout) first.
-- ============================================================================

DROP TABLE IF EXISTS payslips CASCADE;
DROP INDEX IF EXISTS idx_payslips_employee;
DROP INDEX IF EXISTS idx_payslip_employee_id;

CREATE TABLE payslips (
  id                  TEXT PRIMARY KEY,
  employee_id          TEXT NOT NULL,
  employee_name        TEXT NOT NULL DEFAULT '',
  employee_no          TEXT NOT NULL DEFAULT '',
  department_code      TEXT NOT NULL DEFAULT '',
  period              TEXT NOT NULL,                  -- YYYY-MM
  basic_salary_sen      INTEGER NOT NULL DEFAULT 0,
  working_days         INTEGER NOT NULL DEFAULT 26,
  ot_weekday_hours      INTEGER NOT NULL DEFAULT 0,
  ot_sunday_hours       INTEGER NOT NULL DEFAULT 0,
  ot_ph_hours           INTEGER NOT NULL DEFAULT 0,
  hourly_rate_sen       INTEGER NOT NULL DEFAULT 0,
  ot_weekday_amt_sen     INTEGER NOT NULL DEFAULT 0,
  ot_sunday_amt_sen      INTEGER NOT NULL DEFAULT 0,
  ot_ph_amt_sen          INTEGER NOT NULL DEFAULT 0,
  total_ot_sen          INTEGER NOT NULL DEFAULT 0,
  allowances_sen       INTEGER NOT NULL DEFAULT 0,
  gross_pay_sen         INTEGER NOT NULL DEFAULT 0,
  epf_employee_sen      INTEGER NOT NULL DEFAULT 0,
  epf_employer_sen      INTEGER NOT NULL DEFAULT 0,
  socso_employee_sen    INTEGER NOT NULL DEFAULT 0,
  socso_employer_sen    INTEGER NOT NULL DEFAULT 0,
  eis_employee_sen      INTEGER NOT NULL DEFAULT 0,
  eis_employer_sen      INTEGER NOT NULL DEFAULT 0,
  pcb_sen              INTEGER NOT NULL DEFAULT 0,
  total_deductions_sen  INTEGER NOT NULL DEFAULT 0,
  net_pay_sen           INTEGER NOT NULL DEFAULT 0,
  bank_account         TEXT NOT NULL DEFAULT '',
  payroll_run_id        TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | APPROVED | PAID
  created_at          TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at          TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  UNIQUE (employee_id, period)
);

CREATE INDEX idx_payslips_period    ON payslips(period);
CREATE INDEX idx_payslips_employee  ON payslips(employee_id);
CREATE INDEX idx_payslips_status    ON payslips(status);
