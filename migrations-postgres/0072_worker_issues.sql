-- ============================================================================
-- HOOKKA ERP — Worker shop-floor issue reports (Postgres flavour).
--
-- See migrations/0072_worker_issues.sql for the rationale.  The columns are
-- snake_case here — the SupabaseAdapter rename map (column-rename-map.json)
-- translates camelCase route SQL to these names at query time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS worker_issues (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  photo_data_url TEXT,
  reported_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  status TEXT NOT NULL DEFAULT 'OPEN'
);

CREATE INDEX IF NOT EXISTS idx_worker_issues_worker_id
  ON worker_issues(worker_id, reported_at DESC);
