-- ---------------------------------------------------------------------------
-- Phase 4 — Postgres materialized views for dashboard KPI.
--
-- Purpose: precompute the home-page KPI tiles so `GET /api/dashboard` reads
-- a handful of rows from a MV instead of scanning sales_orders /
-- production_orders / invoices on every call.
--
-- Refresh: a Cloudflare Cron Trigger calls `POST /api/internal/refresh-mvs`
-- every 5 minutes (see functions/api/_cron/refresh-mvs.ts).  Refreshing
-- CONCURRENTLY requires a unique index on the MV — added at creation.
-- ---------------------------------------------------------------------------

-- Open SO count + total value by status.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_so_summary AS
SELECT
  status,
  count(*)::int          AS order_count,
  coalesce(sum(total_sen), 0)::bigint AS total_sen
FROM sales_orders
GROUP BY status;

CREATE UNIQUE INDEX IF NOT EXISTS mv_so_summary_pk ON mv_so_summary(status);

-- Production order pipeline by status.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_po_pipeline AS
SELECT
  status,
  count(*)::int          AS po_count
FROM production_orders
GROUP BY status;

CREATE UNIQUE INDEX IF NOT EXISTS mv_po_pipeline_pk ON mv_po_pipeline(status);

-- Job cards by department + status — drives the shop-floor overview.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_jc_by_dept AS
SELECT
  department_code,
  status,
  count(*)::int          AS jc_count
FROM job_cards
GROUP BY department_code, status;

CREATE UNIQUE INDEX IF NOT EXISTS mv_jc_by_dept_pk
  ON mv_jc_by_dept(department_code, status);

-- Stock on hand summary — just raw material totals, fast enough for
-- listing and trendable via Phase 6 Queues later.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rm_stock_on_hand AS
SELECT
  rm.id                                 AS rm_id,
  rm.item_code                          AS item_code,
  rm.description                        AS description,
  coalesce(sum(b.remaining_qty), 0)::double precision AS stock_qty,
  coalesce(sum(b.total_value_sen), 0)::bigint         AS stock_value_sen
FROM raw_materials rm
LEFT JOIN rm_batches b ON b.rm_id = rm.id
GROUP BY rm.id, rm.item_code, rm.description;

CREATE UNIQUE INDEX IF NOT EXISTS mv_rm_stock_on_hand_pk
  ON mv_rm_stock_on_hand(rm_id);

-- Helper function — refresh all four views.  Called by the Cron worker.
-- Using a procedure keeps the SQL server-side; the Worker just invokes it.
CREATE OR REPLACE FUNCTION refresh_dashboard_mvs() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_so_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_po_pipeline;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_jc_by_dept;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_rm_stock_on_hand;
END
$$ LANGUAGE plpgsql;
