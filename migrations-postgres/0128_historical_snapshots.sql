-- ---------------------------------------------------------------------------
-- 0128_historical_snapshots.sql — cache-aside snapshot tables for the two
-- historical aggregation endpoints missed in the PR 7 sweep:
--   GET /api/production-orders/historical-wips
--   GET /api/production-orders/historical-fgs
--
-- Both endpoints call fetchAllPOs() — a scan of every production order +
-- every job card — then dedup into a small distinct-WIP / distinct-FG
-- list. Heavy compute, tiny result: textbook cache-aside candidates.
-- Same shape as 0127_remaining_snapshots.sql (composite PK org_id +
-- cache_key; both endpoints take no query params so cache_key stays '').
--
-- Driven by the generic helper in src/api/lib/snapshot.ts; freshness via
-- the schema-aware probe in src/api/lib/snapshot-freshness.ts over
-- production_orders + job_cards.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS historical_wips_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);

CREATE TABLE IF NOT EXISTS historical_fgs_snapshot (
  org_id        TEXT NOT NULL,
  cache_key     TEXT NOT NULL DEFAULT '',
  data          JSONB NOT NULL,
  built_from    TIMESTAMP NOT NULL,
  built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
