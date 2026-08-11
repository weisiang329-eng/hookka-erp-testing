-- 0223: Trade-finance draw metadata + repayment allocations (owner 2026-08-11).
--
-- Runtime self-applied by ensureTfTables (src/api/lib/trade-finance.ts) —
-- this file documents the schema for the owner's SQL editor. Amounts are NOT
-- stored here: a draw's amount is always the live ledger family net on the
-- trade-finance account; only the due date and the repayment allocations are
-- stored state. Config (which accounts are trade finance, lender, tenor)
-- lives in kv_config key 'trade_finance_sources'.

CREATE TABLE IF NOT EXISTS trade_finance_draws (
  draw_source_id TEXT PRIMARY KEY,
  account_code   TEXT NOT NULL,
  draw_date      TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  org_id         TEXT NOT NULL DEFAULT 'hookka-001'
);

CREATE TABLE IF NOT EXISTS trade_finance_repay_allocs (
  id               TEXT PRIMARY KEY,
  repay_payment_no TEXT NOT NULL,
  draw_source_id   TEXT NOT NULL,
  amount_sen       BIGINT NOT NULL,
  org_id           TEXT NOT NULL DEFAULT 'hookka-001'
);
