-- ---------------------------------------------------------------------------
-- 0120_remaining_snapshots.sql — Cache-aside snapshot tables for the
-- remaining 12 aggregation endpoints.
--
-- Same shape as 0115 (dashboard_snapshot) / 0117 (delivery snapshots) /
-- 0118 (invoice_stats_snapshot). All driven by the generic helper in
-- src/api/lib/snapshot.ts.
--
-- Each table:
--   org_id        TEXT NOT NULL PRIMARY KEY  — multi-tenant scope
--   data          JSONB NOT NULL              — full endpoint response
--   built_from    TIMESTAMP                   — Layer 2 freshness check
--   built_at      TIMESTAMP DEFAULT NOW()     — observability
--   refresh_count INTEGER DEFAULT 0           — monotonic counter
--
-- Source-table coverage per snapshot lives in the application config
-- (each endpoint's handler constructs its own SnapshotConfig). See
-- src/api/routes/*.ts for the per-endpoint source list.
-- ---------------------------------------------------------------------------

-- Sales Orders status bucket counts + value totals.
CREATE TABLE IF NOT EXISTS sales_orders_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Consignment Orders status bucket counts.
CREATE TABLE IF NOT EXISTS consignment_orders_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Consignment Notes status bucket counts.
CREATE TABLE IF NOT EXISTS consignment_notes_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Job Cards summary — production minutes per worker over a date window.
-- Cache key is per-org only; the date window is computed from "today" so
-- the snapshot naturally rolls forward each day (next-day read triggers
-- recompute because job_cards or working_hour_entries.updated_at will be
-- newer than built_from).
CREATE TABLE IF NOT EXISTS job_cards_summary_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Working Hour Entries summary — hours per worker over date window.
CREATE TABLE IF NOT EXISTS whe_summary_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Working Hour Entries dept-category summary — hours per dept × category.
CREATE TABLE IF NOT EXISTS whe_dept_category_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- AR/AP aging buckets (Accounting page).
CREATE TABLE IF NOT EXISTS accounting_aging_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Cost ledger month-to-date / period summary.
CREATE TABLE IF NOT EXISTS cost_ledger_summary_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Supplier scorecards summary.
CREATE TABLE IF NOT EXISTS supplier_scorecards_summary_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Worker team stats (Employees page).
CREATE TABLE IF NOT EXISTS worker_team_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Production overdue counts (Production Overview page).
CREATE TABLE IF NOT EXISTS production_overdue_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

-- Department performance summary (per-dept productivity).
CREATE TABLE IF NOT EXISTS department_performance_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
