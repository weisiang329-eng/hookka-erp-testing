-- Mirror of migrations-postgres/0173 for the rename-map convention.
CREATE TABLE IF NOT EXISTS other_party_bills (
  id              TEXT PRIMARY KEY,
  billNo          TEXT NOT NULL,
  partyId         TEXT NOT NULL,
  partyType       TEXT NOT NULL CHECK (partyType IN ('DEBTOR','CREDITOR')),
  partyName       TEXT NOT NULL,
  billDate        TEXT NOT NULL,
  referenceNo     TEXT,
  description     TEXT,
  subtotalSen     INTEGER NOT NULL DEFAULT 0,
  taxSen          INTEGER NOT NULL DEFAULT 0,
  totalSen        INTEGER NOT NULL DEFAULT 0,
  paidAmountSen   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL_PAID','PAID')),
  orgId           TEXT NOT NULL DEFAULT 'hookka',
  createdAt       TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_other_party_bills_no ON other_party_bills (orgId, billNo);
CREATE INDEX IF NOT EXISTS idx_other_party_bills_party ON other_party_bills (partyId, status);
CREATE INDEX IF NOT EXISTS idx_other_party_bills_type ON other_party_bills (orgId, partyType, status);

CREATE TABLE IF NOT EXISTS other_party_bill_items (
  id              TEXT PRIMARY KEY,
  billId          TEXT NOT NULL REFERENCES other_party_bills(id) ON DELETE CASCADE,
  counterAccount  TEXT NOT NULL,
  amountSen       INTEGER NOT NULL,
  description     TEXT,
  lineNo          INTEGER NOT NULL,
  createdAt       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_other_party_bill_items_bill ON other_party_bill_items (billId);
