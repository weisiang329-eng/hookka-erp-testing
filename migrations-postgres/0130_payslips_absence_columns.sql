-- ---------------------------------------------------------------------------
-- 0130_payslips_absence_columns.sql — payslip absence breakdown
--
-- The payslip generator (POST /api/payslips) is moving onto the shared
-- labor engine (src/lib/labor-engine.ts), replacing the previous
-- random-OT placeholder. The engine derives basic pay as
-- (full monthly salary − absence deduction), so the payslip needs to
-- store that breakdown to show the worker "full salary → minus absences
-- → basic earned" rather than just the final figure.
--
--   absent_days           — elapsed working days the worker logged no
--                           hours for (public holidays are NOT absences)
--   absence_deduction_sen — money docked for those days, at full salary
--                           ÷ workingDaysPerMonth (26) per absent day
--
-- basic_salary_sen keeps its meaning — the full monthly salary. After
-- this migration gross_pay_sen = basic_salary_sen − absence_deduction_sen
-- + total_ot_sen. Existing rows keep 0/0 (they predate the engine).
-- ---------------------------------------------------------------------------

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS absent_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS absence_deduction_sen INTEGER NOT NULL DEFAULT 0;
