-- ---------------------------------------------------------------------------
-- 0117_delivery_snapshots.sql — Cache-aside snapshot tables for the two
-- hot Delivery Orders endpoints.
--
-- Pattern mirrors migrations-postgres/0115_dashboard_snapshot.sql.
-- See src/api/lib/delivery-snapshot.ts for the read-through cache
-- helper that maintains these rows.
--
-- Tables:
--   delivery_stats_snapshot      — caches GET /api/delivery-orders/stats
--                                  (byStatus + valueByStatus + total).
--   delivery_po_values_snapshot  — caches GET /api/delivery-orders/po-values
--                                  ({ poId: salesValueSen } map; the heavy
--                                  per-PO resolver that's currently the
--                                  primary cause of Delivery page lag).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS delivery_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS delivery_po_values_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
