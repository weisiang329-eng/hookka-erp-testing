-- ============================================================================
-- HOOKKA ERP — Finance Phase 1: Other Debtor / Other Creditor registry
-- (SQLite mirror of migrations-postgres/0155_other_parties.sql — D1 is
--  retired; kept for the d1-to-postgres identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS other_parties (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('DEBTOR','CREDITOR')),
  name          TEXT NOT NULL,
  contactPerson TEXT,
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  isActive      INTEGER NOT NULL DEFAULT 1,
  orgId         TEXT NOT NULL DEFAULT 'hookka',
  createdAt     TEXT,
  updatedAt     TEXT
);

CREATE INDEX IF NOT EXISTS idx_other_parties_type ON other_parties (orgId, type, isActive);
