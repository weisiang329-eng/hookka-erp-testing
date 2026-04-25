-- ---------------------------------------------------------------------------
-- 9902_mv_revenue_by_month.sql — Phase C #5 quick-win.
--
-- Materialized view powering the homepage / dashboard revenue chart.
-- Pre-aggregates sales_orders by (orgId, year-month) so the dashboard pulls
-- ~12 rows per tenant instead of scanning the full SO table on every page
-- load. The orgId scope means a future second tenant gets its own row set
-- and dashboard queries naturally remain isolated.
--
-- Refresh: piggybacks on the existing dashboard MV refresh function added
-- in 9901_dashboard_mat_views.sql. The Cron worker calls
-- `SELECT refresh_dashboard_mvs()` and we extend that function below to
-- include the new view. Refresh is CONCURRENT — requires the unique index
-- defined here.
--
-- Schema notes:
--   * org_id (snake_case) — matches Postgres convention; corresponds to
--     orgId in the SQLite source schema (rewritten by the d1-compat layer).
--   * total_sen is INTEGER in the source (sen, no decimals). SUM is widened
--     to bigint to avoid overflow at scale (>2.1B sen = >RM21M monthly).
--   * to_char(date_trunc('month', ...), 'YYYY-MM') gives a stable text key
--     usable as the unique index without any timezone ambiguity.
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS mv_revenue_by_month_by_org;

CREATE MATERIALIZED VIEW mv_revenue_by_month_by_org AS
  SELECT
    org_id                                                               AS org_id,
    to_char(date_trunc('month', created_at::timestamp), 'YYYY-MM')       AS month,
    SUM(total_sen)::bigint                                               AS revenue_sen,
    COUNT(*)::int                                                        AS order_count
  FROM sales_orders
  GROUP BY org_id, to_char(date_trunc('month', created_at::timestamp), 'YYYY-MM');

CREATE UNIQUE INDEX idx_mv_revenue_org_month
  ON mv_revenue_by_month_by_org(org_id, month);

-- Extend the existing refresh helper so a single cron call refreshes every
-- dashboard MV including the new revenue view. CREATE OR REPLACE keeps the
-- function callable from /api/internal/refresh-mvs without redeploying the
-- Worker.
CREATE OR REPLACE FUNCTION refresh_dashboard_mvs() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_so_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_po_pipeline;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_jc_by_dept;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_rm_stock_on_hand;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_revenue_by_month_by_org;
END
$$ LANGUAGE plpgsql;
