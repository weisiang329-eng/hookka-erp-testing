-- ============================================================================
-- HOOKKA ERP — Other Party Payments (D2). Settles other_party_bills:
-- CREDITOR payment (DR 405 / CR bank), DEBTOR receipt (DR bank / CR 305).
-- One payment_no spans N rows (one per bill allocation). MYR only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS other_party_payments (
  id           TEXT PRIMARY KEY,
  payment_no   TEXT NOT NULL,
  party_id     TEXT NOT NULL,
  party_type   TEXT NOT NULL CHECK (party_type IN ('DEBTOR','CREDITOR')),
  party_name   TEXT NOT NULL,
  bill_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  amount_sen   INTEGER NOT NULL,
  bank_account TEXT NOT NULL,
  reference    TEXT,
  notes        TEXT,
  org_id       TEXT NOT NULL DEFAULT 'hookka',
  created_at   TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_other_party_payments_no ON other_party_payments (org_id, payment_no);
CREATE INDEX IF NOT EXISTS idx_other_party_payments_bill ON other_party_payments (bill_id);
CREATE INDEX IF NOT EXISTS idx_other_party_payments_party ON other_party_payments (org_id, party_type);
