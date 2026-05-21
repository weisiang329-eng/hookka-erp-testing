-- D1 mirror of 0125_invoice_stats_snapshot.sql.

CREATE TABLE IF NOT EXISTS invoice_stats_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          TEXT NOT NULL,
  built_from    TEXT NOT NULL,
  built_at      TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
