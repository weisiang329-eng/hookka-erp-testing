-- ============================================================================
-- HOOKKA ERP — Finance Phase 1: Other Debtor / Other Creditor registry
--
-- Non-trade counterparties (transporters, deposit holders, staff advances,
-- misc payables/receivables) kept SEPARATE from the operational customers/
-- suppliers tables per owner decision — they must never appear in the
-- SO/PO pickers. Control accounts: 305-0000 OTHER DEBTOR (asset) and
-- 405-0000 OTHER CREDITORS (liability), both already in the live COA.
-- Phase 3's Payment/Expense & Official Receipt vouchers reference these
-- parties; per-party balances derive from the immutable ledger then.
-- ============================================================================

CREATE TABLE IF NOT EXISTS other_parties (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('DEBTOR','CREDITOR')),
  name           TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  org_id         TEXT NOT NULL DEFAULT 'hookka',
  created_at     TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_other_parties_type ON other_parties (org_id, type, is_active);
