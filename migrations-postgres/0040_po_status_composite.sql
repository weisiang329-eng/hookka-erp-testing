-- ---------------------------------------------------------------------------
-- 0040_po_status_composite.sql — covering index for the Production page's
-- hot list query.
--
-- Hot query (from src/api/routes-d1/production-orders.ts fetchFilteredPOs /
-- fetchPaginatedPOs):
--   SELECT * FROM production_orders
--    WHERE status IN (?, ?, ?)
--    ORDER BY created_at DESC, id DESC;
--
-- The Production page fires this with status=PENDING,IN_PROGRESS,ON_HOLD on
-- every mount. With ~530 POs in prod today and no composite index on
-- (status, created_at), SQLite falls back to a status-only index and re-sorts
-- in memory — measured at 3.2s on remote D1.
--
-- This composite reorders naturally on (status, created_at DESC) so the
-- ORDER BY is served by the index walk rather than a temp-B-tree sort. DESC
-- on the trailing column is legal on SQLite (since 3.3) and matches the
-- query's sort direction exactly.
--
-- Idempotent via IF NOT EXISTS.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_po_status_updated
  ON production_orders(status, created_at DESC);
