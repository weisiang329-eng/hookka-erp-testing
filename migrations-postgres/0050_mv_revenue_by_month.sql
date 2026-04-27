-- ---------------------------------------------------------------------------
-- 0050_mv_revenue_by_month.sql — Phase C #5 quick-win.
--
-- D1 has no MATERIALIZED VIEW support. The actual MV lives in Postgres
-- (Supabase) — see migrations-postgres/9902_mv_revenue_by_month.sql. This
-- placeholder is kept so the migration numbering remains parallel between
-- the two trees and a fresh D1 rebuild does not silently miss the row.
--
-- The dashboard revenue endpoint (src/api/routes-d1/dashboard-revenue.ts)
-- queries the MV via the D1-compat adapter, which maps to the Postgres
-- view directly — there is no SQLite-side artefact to create.
-- ---------------------------------------------------------------------------

-- (intentionally empty)
SELECT 1 AS noop;
