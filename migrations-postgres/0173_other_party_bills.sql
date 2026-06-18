-- ============================================================================
-- HOOKKA ERP — Other Party Bills (D1). Non-trade debtor/creditor bills with
-- multi-line counter accounts + an optional single tax amount. Posts to the
-- immutable ledger on save (sourceType 'other_party_bill'); control accounts
-- 305-0000 (debtor) / 405-0000 (creditor). Settlement (pay/receive) is D2.
-- ============================================================================

CREATE TABLE IF NOT EXISTS other_party_bills (
  id              TEXT PRIMARY KEY,
  bill_no         TEXT NOT NULL,
  party_id        TEXT NOT NULL,
  party_type      TEXT NOT NULL CHECK (party_type IN ('DEBTOR','CREDITOR')),
  party_name      TEXT NOT NULL,
  bill_date       TEXT NOT NULL,
  reference_no    TEXT,
  description     TEXT,
  subtotal_sen    INTEGER NOT NULL DEFAULT 0,
  tax_sen         INTEGER NOT NULL DEFAULT 0,
  total_sen       INTEGER NOT NULL DEFAULT 0,
  paid_amount_sen INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL_PAID','PAID')),
  org_id          TEXT NOT NULL DEFAULT 'hookka',
  created_at      TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_other_party_bills_no ON other_party_bills (org_id, bill_no);
CREATE INDEX IF NOT EXISTS idx_other_party_bills_party ON other_party_bills (party_id, status);
CREATE INDEX IF NOT EXISTS idx_other_party_bills_type ON other_party_bills (org_id, party_type, status);

CREATE TABLE IF NOT EXISTS other_party_bill_items (
  id              TEXT PRIMARY KEY,
  bill_id         TEXT NOT NULL REFERENCES other_party_bills(id) ON DELETE CASCADE,
  counter_account TEXT NOT NULL,
  amount_sen      INTEGER NOT NULL,
  description     TEXT,
  line_no         INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_other_party_bill_items_bill ON other_party_bill_items (bill_id);
