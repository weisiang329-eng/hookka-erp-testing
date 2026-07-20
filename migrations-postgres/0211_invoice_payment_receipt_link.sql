-- 0211 — Stable invoice-payment to receipt linkage.
--
-- invoice_payments historically duplicated a receipt allocation without the
-- payment_records id. That made a restate/void/bounce impossible to reflect in
-- invoice detail safely: date/reference/amount are not unique identifiers.
-- Keep legacy rows nullable and visible; every new linked row is protected by
-- tenant-aware composite foreign keys. NOT VALID avoids pretending historical
-- org defaults are already clean while still enforcing all new writes.

ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS payment_record_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_payment_record_id
  ON invoice_payments(payment_record_id);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_org_date
  ON invoice_payments(org_id, date);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_id_org
  ON payment_records(id, org_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_id_org
  ON invoices(id, org_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_payments_payment_record_org_fkey'
  ) THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_payment_record_org_fkey
      FOREIGN KEY (payment_record_id, org_id)
      REFERENCES payment_records(id, org_id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_payments_invoice_org_fkey'
  ) THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_invoice_org_fkey
      FOREIGN KEY (invoice_id, org_id)
      REFERENCES invoices(id, org_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

-- No automatic legacy backfill. A row is safe to link only when an operator or
-- a deterministic audit proves exactly one receipt owns it. Ambiguous rows stay
-- NULL and are reported by the API audit endpoint added with this migration.
