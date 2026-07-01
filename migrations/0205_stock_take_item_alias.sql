-- 0205_stock_take_item_alias.sql — remembered (item -> material group) mapping
-- for the raw (uncategorized) monthly stock-take import (owner rule 2026-07-01).
-- item_group NULL means "deliberately not a stock line" (Ignore this line).
-- INERT double-track record — prod gets the table via ensureStockTakeItemAlias()
-- runtime self-apply in src/api/routes/accounting.ts.
CREATE TABLE IF NOT EXISTS stock_take_item_alias (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'hookka',
  item_key   TEXT NOT NULL,
  item_group TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_item_alias_key ON stock_take_item_alias (org_id, item_key);
