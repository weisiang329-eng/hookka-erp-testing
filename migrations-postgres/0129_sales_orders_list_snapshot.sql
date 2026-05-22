-- ---------------------------------------------------------------------------
-- 0129_sales_orders_list_snapshot.sql — cache-aside snapshot table for the
-- full sales-order list endpoint:
--   GET /api/sales-orders        (no ?page / ?limit — the un-paginated branch)
--
-- The dashboard fetches the entire SO list to build a per-product unit-price
-- map for the Pending Delivery KPI. That request is a whole-table SELECT *
-- over sales_orders + sales_order_items (items capped at 5,000 rows) — one
-- of the two heaviest dashboard reads, and the list itself is relatively
-- static (a confirmed SO rarely changes after creation). Textbook
-- cache-aside candidate.
--
-- Same shape as 0127_remaining_snapshots.sql (composite PK org_id +
-- cache_key; the un-paginated list takes no query params so cache_key
-- stays ''). Driven by the generic helper in src/api/lib/snapshot.ts;
-- freshness via the schema-aware probe in src/api/lib/snapshot-freshness.ts
-- over sales_orders + sales_order_items.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_orders_list_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
