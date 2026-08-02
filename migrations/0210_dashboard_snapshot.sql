-- Finance dashboard cache-aside snapshot (perf/coa-window).
--
-- GET /api/accounting/dashboard replays computePnlWindow for up to 12 months
-- plus a per-month cost-structure pass, measured ~1,950ms on EVERY call. It is
-- now wrapped in withSnapshot + staleWhileRevalidate, which reads this table.
--
-- Migrations are inert on deploy (see CLAUDE.md), so the route also runtime-
-- ensures this table with CREATE TABLE IF NOT EXISTS before the first read.
-- This file is the durable record + the shape for a fresh environment. Mirrors
-- accounting_aging_snapshot (migration 0082) exactly.
CREATE TABLE IF NOT EXISTS accounting_dashboard_snapshot (
  org_id TEXT NOT NULL,
  cache_key TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  built_from TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT '',
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
