-- Mirror of migrations-postgres/0175 for the rename-map convention.
CREATE TABLE IF NOT EXISTS other_party_payments (
  id           TEXT PRIMARY KEY,
  paymentNo    TEXT NOT NULL,
  partyId      TEXT NOT NULL,
  partyType    TEXT NOT NULL CHECK (partyType IN ('DEBTOR','CREDITOR')),
  partyName    TEXT NOT NULL,
  billId       TEXT NOT NULL,
  date         TEXT NOT NULL,
  amountSen    INTEGER NOT NULL,
  bankAccount  TEXT NOT NULL,
  reference    TEXT,
  notes        TEXT,
  orgId        TEXT NOT NULL DEFAULT 'hookka',
  createdAt    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_other_party_payments_no ON other_party_payments (orgId, paymentNo);
CREATE INDEX IF NOT EXISTS idx_other_party_payments_bill ON other_party_payments (billId);
CREATE INDEX IF NOT EXISTS idx_other_party_payments_party ON other_party_payments (orgId, partyType);
