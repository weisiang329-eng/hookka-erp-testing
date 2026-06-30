-- Mirror of migrations-postgres/0200_pnl_historical.sql (sqlite, for the rename-map scanner).
-- Runtime self-applied by the endpoint; CI does not run this file.
CREATE TABLE IF NOT EXISTS pnl_historical (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL DEFAULT 'hookka',
  ym          TEXT NOT NULL,
  line        TEXT NOT NULL,
  window_json TEXT NOT NULL,
  updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_hist_key ON pnl_historical (org_id, ym, line);
