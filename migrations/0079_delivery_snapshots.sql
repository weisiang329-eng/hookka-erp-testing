-- D1 mirror of 0124_delivery_snapshots.sql. See that file for full
-- architecture commentary.

CREATE TABLE IF NOT EXISTS delivery_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          TEXT NOT NULL,
  built_from    TEXT NOT NULL,
  built_at      TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS delivery_po_values_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          TEXT NOT NULL,
  built_from    TEXT NOT NULL,
  built_at      TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
