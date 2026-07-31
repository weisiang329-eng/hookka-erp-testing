-- 0209_inventory_perf_indexes.sql
--
-- fg-stock hot-path indexes (owner 2026-07-30: "delete a SKU and the whole page
-- flashes back to the dashboard"). Root cause: GET /api/inventory/fg-stock does
-- a whole-org finished-goods derivation on a cold/expired snapshot that FULL-
-- SCANS the two biggest tables on the path (job_cards, piece_pics) plus a
-- per-request MAX(updated_at) freshness probe over six source tables. As prod
-- data grew, that compute crossed the frontend's 30s /api/* abort → 504, and a
-- 504 here crashes the Inventory page on ANY refetch (delete / edit / refresh).
--
-- Indices:
--   • job_cards(org_id)                    — the fetchFilteredPOs legacy full-fetch
--     (SELECT * FROM job_cards WHERE org_id = ?, ~9k rows) had no org_id index.
--   • piece_pics(org_id, job_card_id) WHERE pic1_id IS NOT NULL — the
--     fetchPiecesDoneByJc GROUP BY over the largest table (partial: matches the
--     `pic1_id IS NOT NULL` predicate exactly, keeps the index small).
--   • products(org_id, status)             — the ACTIVE-products read.
--   • {job_cards, production_orders, delivery_orders, delivery_order_items,
--      consignment_notes, consignment_items}(updated_at) — the every-request
--     freshness probe's per-table MAX(updated_at).
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The indices reach prod ONLY via the runtime self-apply in
-- src/api/lib/ensure-inventory-perf-indexes.ts (ensureInventoryPerfIndexes,
-- queued via executionCtx.waitUntil at the top of the /fg-stock handler). This
-- file is the schema source-of-truth / fresh-DB bootstrap.

CREATE INDEX IF NOT EXISTS idx_job_cards_org_id
  ON job_cards (org_id);

CREATE INDEX IF NOT EXISTS idx_piece_pics_org_jc_done
  ON piece_pics (org_id, job_card_id) WHERE pic1_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_org_status
  ON products (org_id, status);

CREATE INDEX IF NOT EXISTS idx_job_cards_updated_at
  ON job_cards (updated_at);

CREATE INDEX IF NOT EXISTS idx_production_orders_updated_at
  ON production_orders (updated_at);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_updated_at
  ON delivery_orders (updated_at);

CREATE INDEX IF NOT EXISTS idx_delivery_order_items_updated_at
  ON delivery_order_items (updated_at);

CREATE INDEX IF NOT EXISTS idx_consignment_notes_updated_at
  ON consignment_notes (updated_at);

CREATE INDEX IF NOT EXISTS idx_consignment_items_updated_at
  ON consignment_items (updated_at);
