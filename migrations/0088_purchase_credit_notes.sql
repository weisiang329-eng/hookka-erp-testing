-- ============================================================================
-- HOOKKA ERP — Finance Phase 2: purchase credit notes (supplier CN)
-- (SQLite mirror of migrations-postgres/0156_purchase_credit_notes.sql —
--  D1 retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS purchase_credit_notes (
  id                TEXT PRIMARY KEY,
  noteNumber        TEXT NOT NULL,
  supplierId        TEXT NOT NULL,
  supplierName      TEXT NOT NULL DEFAULT '',
  purchaseInvoiceId TEXT,
  piNo              TEXT,
  date              TEXT NOT NULL,
  reason            TEXT,
  reasonDetail      TEXT,
  items             TEXT,
  totalAmount       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  orgId             TEXT NOT NULL DEFAULT 'hookka',
  createdAt         TEXT,
  updatedAt         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pcn_supplier ON purchase_credit_notes (orgId, supplierId, status);
