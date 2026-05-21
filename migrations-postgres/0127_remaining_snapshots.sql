-- ---------------------------------------------------------------------------
-- 0127_remaining_snapshots.sql — Cache-aside snapshot tables for the
-- remaining 12 aggregation endpoints.
--
-- Same shape as 0122 (dashboard_snapshot) / 0124 (delivery snapshots) /
-- 0125 (invoice_stats_snapshot), with one upgrade: composite primary
-- key (org_id, cache_key). cache_key encodes any query-string params
-- the endpoint accepts (e.g. "from=2026-05-14&to=2026-05-20" for
-- job-cards/summary). For endpoints with no params, cache_key = ''.
-- This lets the same snapshot table hold rows for multiple param
-- combinations without one stomping another.
--
-- All driven by the generic helper in src/api/lib/snapshot.ts which
-- accepts an optional cacheKey parameter.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_orders_stats_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS consignment_orders_stats_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS consignment_notes_stats_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS job_cards_summary_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS whe_summary_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS whe_dept_category_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS accounting_aging_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS cost_ledger_summary_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS supplier_scorecards_summary_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS worker_team_stats_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS production_overdue_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS department_performance_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
