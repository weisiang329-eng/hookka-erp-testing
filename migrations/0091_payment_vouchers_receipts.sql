-- ============================================================================
-- HOOKKA ERP — Payment/Expense vouchers + Official Receipts
-- (SQLite mirror of migrations-postgres/0159_payment_vouchers_receipts.sql
--  — D1 retired; kept for the rename-map identifier scan + schema parity.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_vouchers (
  id             TEXT PRIMARY KEY,
  pvNo           TEXT NOT NULL UNIQUE,
  date           TEXT NOT NULL,
  payee          TEXT,
  description    TEXT,
  payFrom        TEXT,
  accrued        INTEGER NOT NULL DEFAULT 0,
  accrualAccount TEXT,
  settledAt      TEXT,
  productLine    TEXT,
  totalSen       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'POSTED',
  createdBy      TEXT,
  created_at     TEXT,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS payment_voucher_lines (
  id          TEXT PRIMARY KEY,
  voucherId   TEXT NOT NULL,
  accountCode TEXT NOT NULL,
  description TEXT,
  amountSen   INTEGER NOT NULL,
  lineOrder   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS official_receipts (
  id           TEXT PRIMARY KEY,
  orNo         TEXT NOT NULL UNIQUE,
  date         TEXT NOT NULL,
  receivedFrom TEXT,
  description  TEXT,
  payTo        TEXT NOT NULL,
  totalSen     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'POSTED',
  createdBy    TEXT,
  created_at   TEXT,
  updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS official_receipt_lines (
  id          TEXT PRIMARY KEY,
  receiptId   TEXT NOT NULL,
  accountCode TEXT NOT NULL,
  description TEXT,
  amountSen   INTEGER NOT NULL,
  lineOrder   INTEGER NOT NULL DEFAULT 0
);
