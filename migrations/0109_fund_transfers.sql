-- Mirror of migrations-postgres/0190_fund_transfers.sql (record only). All
-- columns are snake_case and queried as such (resolver + POST /fund-transfers),
-- so there is nothing for the rename-map scanner. Runtime self-applied by the
-- endpoint (ensureFundTransfersTable); CI does not run this file.
CREATE TABLE IF NOT EXISTS fund_transfers (
  id          TEXT PRIMARY KEY,
  transfer_no TEXT NOT NULL,
  date        TEXT NOT NULL,
  org_id      TEXT NOT NULL DEFAULT 'hookka',
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fund_transfers_no ON fund_transfers (org_id, transfer_no);
