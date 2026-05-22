-- ---------------------------------------------------------------------------
-- 0083_sales_orders_list_snapshot.sql — D1 / SQLite source for postgres 0129.
--
-- Cache-aside snapshot table for the full sales-order list endpoint
-- (GET /api/sales-orders with no ?page / ?limit — the un-paginated branch).
-- The dashboard fetches the entire list to resolve per-product SO unit
-- prices for the Pending Delivery KPI; that is a whole-table SELECT * over
-- sales_orders + sales_order_items, one of the two heaviest dashboard
-- reads. Same shape as 0082_remaining_snapshots.sql (composite PK
-- org_id + cache_key; the un-paginated list takes no query params so
-- cache_key stays '').
--
-- Driven by the generic helper in src/api/lib/snapshot.ts; freshness via
-- the schema-aware probe in src/api/lib/snapshot-freshness.ts over
-- sales_orders + sales_order_items.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_orders_list_snapshot (
  org_id TEXT NOT NULL, cache_key TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL, built_from TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
