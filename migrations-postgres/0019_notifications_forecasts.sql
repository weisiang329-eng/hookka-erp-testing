-- ============================================================================
-- 0019_notifications_forecasts.sql
--
-- NO-OP migration. The `notifications` and `forecast_entries` tables were
-- created by a sibling migration in the same deployment batch (both were
-- originally authored as 0013 in parallel worktrees; numbering was
-- reconciled at merge time). This file is retained only for migration-chain
-- continuity — the actual DDL + seed lives in the earlier migration that
-- was applied to remote D1 first.
--
-- Routes that depend on these tables:
--   * src/api/routes-d1/notifications.ts — reads `created_at` column
--   * src/api/routes-d1/forecasts.ts     — forecastQty/actualQty are DOUBLE PRECISION
-- ============================================================================

-- Intentionally empty. Do not add DDL here — the tables already exist.
SELECT 1;
