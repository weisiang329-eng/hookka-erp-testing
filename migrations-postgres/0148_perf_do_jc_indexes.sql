-- ---------------------------------------------------------------------------
-- 0148_perf_do_jc_indexes.sql — two missing indexes for the 2026-06-04 perf
-- investigation. System Health was Critical (overall P95 5.4s); the worst
-- endpoints were GET /api/delivery-orders and /api/production-orders at
-- P95 10-19s, and every request paid an unindexed freshness-probe scan.
--
-- !! RUN OUTSIDE A TRANSACTION !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block (same as
-- 0133). Apply via `npm run db:migrate:supabase` with the per-file tx
-- disabled, or paste into the Supabase SQL editor. CONCURRENTLY is used so
-- the build does NOT take an ACCESS EXCLUSIVE lock on these hot tables.
--
-- Why each index:
--   idx_do_org_created  — GET /api/delivery-orders ORDER BY (org_id,
--                         created_at DESC). delivery_orders had only
--                         idx_delivery_orders_org_id / idx_do_status /
--                         idx_do_sales_order_id, so the list sort was a
--                         full-table sort. Mirrors idx_so_org_created (0133).
--   idx_jc_updated_at   — job_cards freshness probe MAX(updated_at), run by
--                         the snapshot helper on EVERY /api/production-orders
--                         request (warm cache hits included). job_cards is the
--                         largest table; without this each request paid a
--                         full-column scan. Mirrors idx_so_updated_at (0133).
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_do_org_created
  ON delivery_orders(org_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jc_updated_at
  ON job_cards(updated_at);
