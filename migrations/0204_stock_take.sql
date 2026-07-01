-- 0204_stock_take.sql — month-end stock-take (owner periodic-inventory option,
-- 2026-06-30). Per material-group closing value the owner enters at each
-- month-end; the P&L material engine uses it as that period's CLOSING (and the
-- prior month's as OPENING) instead of the FIFO/BOM value, for groups that have
-- one. Coexists with FIFO. INERT double-track record — prod gets the table via
-- ensureStockTake() runtime self-apply in src/api/routes/accounting.ts.
CREATE TABLE IF NOT EXISTS stock_take (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL DEFAULT 'hookka',
  item_group TEXT NOT NULL,
  ym         TEXT NOT NULL,
  value_sen  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_key ON stock_take (org_id, item_group, ym);
