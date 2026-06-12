-- ============================================================================
-- HOOKKA ERP — bank reconciliation statement lines
-- (SQLite mirror of migrations-postgres/0160_bank_statement_lines.sql — D1
--  retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id           TEXT PRIMARY KEY,
  accountCode  TEXT NOT NULL,
  txnDate      TEXT NOT NULL,
  description  TEXT,
  amountSen    INTEGER NOT NULL,
  matchedLegId TEXT,
  matchedAt    TEXT,
  importedAt   TEXT,
  created_at   TEXT
);
