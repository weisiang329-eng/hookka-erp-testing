-- 0210 — how each worker is actually PAID (owner 2026-08-01).
--
-- Two levels, because the owner's rule is "每个月可以改":
--   * workers.*        — the DEFAULT, so the office never re-types it
--   * payslips.*       — the value FOR THAT MONTH, snapshotted at generation
--                        and editable per period without touching the default
--                        or any earlier month.
--
-- payslips.bank_account already exists and today holds a single free-text
-- string like "CIMB-004XXXX" (bank and number run together). Existing rows are
-- deliberately left as they are — splitting them would be guesswork; the bank
-- column simply stays NULL until the office sets it.
ALTER TABLE workers  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER';
ALTER TABLE workers  ADD COLUMN IF NOT EXISTS bank_name      TEXT;
ALTER TABLE workers  ADD COLUMN IF NOT EXISTS bank_account   TEXT;

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER';
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS bank_name      TEXT;
