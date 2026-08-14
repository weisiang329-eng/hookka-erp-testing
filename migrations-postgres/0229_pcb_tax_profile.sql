-- ---------------------------------------------------------------------------
-- 0229_pcb_tax_profile.sql — the inputs PCB needs, and a provenance stamp for
-- the figure it produces. BUG-2026-08-13-121.
--
-- PCB (Potongan Cukai Berjadual) has never been calculated by this system:
-- `calcStatutory` read `workers.pcb_enabled` and then returned `pcbOn ? 0 : 0`
-- — the same number on both branches — so net pay on every payslip is
-- overstated by whatever should have been withheld. The toggle was already
-- modelled (migration 0131); only the calculation was missing.
--
-- LHDN's monthly deduction depends on more than salary: tax residency, marital
-- category, and the child relief the employee has declared. None of those
-- existed on `workers`. They are added here NULLABLE WITH NO DEFAULT, on
-- purpose:
--
--   • tax_residency NULL vs 'RESIDENT' is not a cosmetic difference — a
--     non-resident is withheld a flat 30% of gross from the first ringgit,
--     while a resident on RM 3,000/month owes nothing. Nationality cannot
--     stand in for it (a foreign worker present ≥182 days IS a tax resident).
--   • tax_category NULL vs 'SINGLE' decides whether spouse relief and the
--     second RM 400 rebate apply.
--   • tax_child_relief_sen holds the RELIEF, not a headcount: LHDN gives
--     RM 2,000 for an ordinary child but RM 8,000 for one in full-time
--     tertiary education and RM 14,000 for a disabled child in tertiary
--     education, so count × 2,000 would over-withhold. 0 is a legitimate
--     declared value; NULL means nobody has asked the employee yet.
--
-- Until a worker's profile is filled in, the payslip prints "—" for PCB and
-- says it could not be computed. It does NOT print RM 0.00, because zero
-- withheld and not-computed are different statements about someone's pay.
--
-- payslips.pcb_status records where the pcb_sen beside it came from
-- ('DISABLED' | 'COMPUTED' | 'ZERO_PROVEN' | 'UNKNOWN'). It is NULL on every
-- row generated before this change, and is deliberately NOT backfilled: those
-- payslips were issued without a PCB computation and restating an issued
-- document is not this migration's business.
--
-- Migrations are inert on deploy here — the columns reach production through
-- `ensurePayrollTaxColumns` (src/api/lib/payroll-tax-columns.ts), awaited
-- before the first write in payslips.ts and workers.ts. This file is the
-- record, not the mechanism.
-- ---------------------------------------------------------------------------

ALTER TABLE workers  ADD COLUMN IF NOT EXISTS tax_residency        TEXT;
ALTER TABLE workers  ADD COLUMN IF NOT EXISTS tax_category         TEXT;
ALTER TABLE workers  ADD COLUMN IF NOT EXISTS tax_child_relief_sen BIGINT;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS pcb_status           TEXT;
