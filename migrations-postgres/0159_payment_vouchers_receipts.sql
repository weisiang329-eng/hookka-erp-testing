-- ============================================================================
-- HOOKKA ERP — Finance Phase 3.2/3.3: Payment/Expense vouchers + Official
-- Receipts.
--
-- Payment voucher (PV): pays an expense — DR each line account, CR the
-- SBK/SCH bank/cash account. The owner's 「先挂账」 switch instead credits
-- an accrual account (410-x / 405-0000) at posting and clears it against
-- the bank when the voucher is settled later. Optional product-line tag
-- (SOFA/BEDFRAME) feeds the Phase-4/5 split P&L allocation override.
--
-- Official receipt (OR): money in that is NOT a trade-invoice payment —
-- sundry income, other-debtor recoveries. DR bank/cash, CR each line.
--
-- Both post immediately to the immutable ledger (sourceType
-- 'payment_voucher' / 'payment_voucher_settle' / 'official_receipt');
-- void posts a reversal — rows are never deleted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_vouchers (
  id              TEXT PRIMARY KEY,
  pv_no           TEXT NOT NULL UNIQUE,
  date            TEXT NOT NULL,
  payee           TEXT,
  description     TEXT,
  pay_from        TEXT,                       -- SBK/SCH COA code; NULL while accrued
  accrued         INTEGER NOT NULL DEFAULT 0, -- 先挂账
  accrual_account TEXT,                       -- 410-x / 405-0000 when accrued
  settled_at      TEXT,                       -- stamped when the accrual is cleared
  product_line    TEXT,                       -- SOFA | BEDFRAME | NULL
  total_sen       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOID')),
  created_by      TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS payment_voucher_lines (
  id           TEXT PRIMARY KEY,
  voucher_id   TEXT NOT NULL REFERENCES payment_vouchers(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  description  TEXT,
  amount_sen   INTEGER NOT NULL,
  line_order   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pv_lines_voucher ON payment_voucher_lines (voucher_id);
CREATE INDEX IF NOT EXISTS idx_pv_date ON payment_vouchers (date);

CREATE TABLE IF NOT EXISTS official_receipts (
  id            TEXT PRIMARY KEY,
  or_no         TEXT NOT NULL UNIQUE,
  date          TEXT NOT NULL,
  received_from TEXT,
  description   TEXT,
  pay_to        TEXT NOT NULL,                -- SBK/SCH COA code receiving the money
  total_sen     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOID')),
  created_by    TEXT,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS official_receipt_lines (
  id           TEXT PRIMARY KEY,
  receipt_id   TEXT NOT NULL REFERENCES official_receipts(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL,
  description  TEXT,
  amount_sen   INTEGER NOT NULL,
  line_order   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_or_lines_receipt ON official_receipt_lines (receipt_id);
CREATE INDEX IF NOT EXISTS idx_or_date ON official_receipts (date);
