-- 0210 — Database-level payment balance guards.
--
-- The API validates against a snapshot before its atomic payment batch. Two
-- concurrent requests can both see the same outstanding balance, so the final
-- protection must live in Postgres. NOT VALID keeps rollout additive: existing
-- historical exceptions do not block the migration, while every new/updated
-- row is protected immediately. Historical exceptions can be repaired before
-- these constraints are validated in a later controlled migration.

ALTER TABLE invoices
  ADD CONSTRAINT invoices_paid_amount_within_total
  CHECK (paid_amount >= 0 AND paid_amount <= total_sen) NOT VALID;

ALTER TABLE purchase_invoices
  ADD CONSTRAINT purchase_invoices_paid_amount_within_total
  CHECK (paid_amount_sen >= 0 AND paid_amount_sen <= amount_sen) NOT VALID;

