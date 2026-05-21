-- ---------------------------------------------------------------------------
-- 0123_drop_dashboard_mvs.sql — Tear down the abandoned Materialized View
-- attempt from 9901/9902.
--
-- Agent A audit on 2026-05-20 confirmed:
--   • The 5 dashboard MVs (mv_so_summary, mv_po_pipeline, mv_jc_by_dept,
--     mv_rm_stock_on_hand, mv_revenue_by_month_by_org) WERE refreshing
--     every 15 minutes via the GitHub Actions cron (.github/workflows/
--     refresh-mvs.yml).
--   • But ZERO frontend pages consumed them. /api/dashboard/summary and
--     /api/dashboard/revenue (the two endpoints that read the MVs) had
--     no callers anywhere in src/pages or src/components.
--   • Net result: Supabase was burning CPU every 15 min to refresh
--     materialized views that nobody read.
--
-- PR 1 (claude/dashboard-snapshot) replaces this with an application-
-- managed dashboard_snapshot table + cache-aside reads. The new model
-- is data-change-aware (vs the MV's time-based refresh) and reads via
-- the existing /api/dashboard/overview endpoint that EVERY dashboard
-- page already calls.
--
-- This migration cleans up the abandoned infrastructure:
--   • DROP the 5 MVs (CONCURRENTLY when possible — Postgres requires
--     a regular DROP for MVs; the CONCURRENTLY keyword is for indexes)
--   • DROP the refresh_dashboard_mvs() function
--   • Leave the 0050_mv_revenue_by_month.sql noop placeholder file in
--     place (it's already a no-op SELECT 1, harmless, removing the
--     file changes git history but not the DB)
--
-- Rollback: re-running 9901/9902 manually would re-create the MVs.
-- Not expected to be needed — the new snapshot system is the
-- replacement.
-- ---------------------------------------------------------------------------

DROP MATERIALIZED VIEW IF EXISTS mv_so_summary;
DROP MATERIALIZED VIEW IF EXISTS mv_po_pipeline;
DROP MATERIALIZED VIEW IF EXISTS mv_jc_by_dept;
DROP MATERIALIZED VIEW IF EXISTS mv_rm_stock_on_hand;
DROP MATERIALIZED VIEW IF EXISTS mv_revenue_by_month_by_org;

DROP FUNCTION IF EXISTS refresh_dashboard_mvs();
