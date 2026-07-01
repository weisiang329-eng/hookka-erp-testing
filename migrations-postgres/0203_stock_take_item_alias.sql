-- 0203_stock_take_item_alias.sql — remembered (item -> material group) mapping
-- for the raw (uncategorized) monthly stock-take import (owner rule 2026-07-01).
-- The owner's monthly file has no category column and its layout varies month
-- to month; grouping comes from each physical line's own identity
-- (item_key = normalized identity columns), not a label. item_group NULL means
-- "deliberately not a stock line" (e.g. a GRAND TOTAL trailer row) — set via
-- "Ignore this line" so a recurring non-item row is skipped forever, not
-- re-prompted every month.
--
-- INERT double-track record — prod gets this table via ensureStockTakeItemAlias()
-- runtime self-apply in src/api/routes/accounting.ts (deploys do NOT run
-- migration files).
CREATE TABLE IF NOT EXISTS stock_take_item_alias (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'hookka',
  item_key   TEXT NOT NULL,
  item_group TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_item_alias_key ON stock_take_item_alias (org_id, item_key);
