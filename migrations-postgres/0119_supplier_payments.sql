-- ============================================================================
-- HOOKKA ERP — Supplier payments (AP cash-out)
--
-- Phase 7c: the system had NO record of money paid to suppliers — a
-- purchase invoice going PAID was a bare status flip. This table records
-- the actual payment so AP can clear and the GL can post
-- DR 400-0000 Trade Creditors · CR bank. Mirrors payment_records (the
-- AR side) in shape; one row per supplier payment, optionally linked to
-- the purchase invoice it settles.
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplier_payments (
  id              TEXT PRIMARY KEY,
  payment_no      TEXT NOT NULL,
  supplier_id     TEXT NOT NULL,
  supplier_name   TEXT NOT NULL DEFAULT '',
  purchase_invoice_id TEXT,
  date            TEXT NOT NULL,
  amount_sen      INTEGER NOT NULL DEFAULT 0,
  method          TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
  reference       TEXT,
  notes           TEXT,
  org_id          TEXT NOT NULL DEFAULT 'hookka',
  created_at      TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier
  ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_pi
  ON supplier_payments(purchase_invoice_id);
