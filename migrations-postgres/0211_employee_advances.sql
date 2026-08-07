-- 0211 — salary advances (owner 2026-08-07).
--
-- "员工他们一直在拿 advance，有没有可能在 employee 这边，我可以输入他们拿 advance
--  的金额和日期？… 一个是在 net pay、total pay 里面扣，另一个可能是可以导出一个
--  我要出钱的 listing 给到我的 HR."
--
-- An advance is CASH ALREADY HANDED OVER, not a pay component:
--   * it is not an earning and not a statutory deduction, so gross / EPF /
--     SOCSO / EIS / PCB are untouched;
--   * it belongs to the month of `advance_date` — the owner keys one thing
--     (when he gave the money) and the deduction follows it;
--   * it stays editable until the payroll that recovered it is APPROVED, at
--     which point status flips to SETTLED.
--
-- RECORD ONLY. Deploys do NOT replay this file — the table and the payslips
-- column reach prod through the runtime self-apply in
-- src/api/lib/employee-advances.ts (ensureAdvanceTables), awaited before the
-- first write. Keep the two in step.
CREATE TABLE IF NOT EXISTS employee_advances (
  id             TEXT PRIMARY KEY,
  worker_id      TEXT NOT NULL,
  advance_date   TEXT NOT NULL,          -- YYYY-MM-DD, the day the cash was handed over
  amount_sen     INTEGER NOT NULL,       -- integer sen (RM x 100), never a float
  note           TEXT,
  entered_by     TEXT,                   -- users.id of whoever recorded it
  status         TEXT NOT NULL DEFAULT 'UNSETTLED',  -- UNSETTLED | SETTLED
  settled_period TEXT,                   -- YYYY-MM of the payroll run that recovered it
  settled_at     TIMESTAMPTZ,
  org_id         TEXT NOT NULL DEFAULT 'hookka',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_employee_advances_date
  ON employee_advances (advance_date);
CREATE INDEX IF NOT EXISTS idx_employee_advances_worker_date
  ON employee_advances (worker_id, advance_date);

-- The generated payslip CARRIES the advance it was computed with. Re-deriving
-- it at read time would mean deleting an advance months later silently moved an
-- approved net pay. Legacy rows default to 0, so every payslip generated before
-- this change keeps exactly the net pay it was approved with.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS advance_deduction_sen INTEGER NOT NULL DEFAULT 0;
