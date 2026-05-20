-- ---------------------------------------------------------------------------
-- 0076_dashboard_snapshot.sql — D1 / SQLite mirror of postgres 0115.
--
-- See migrations-postgres/0115_dashboard_snapshot.sql for the full
-- architecture comment. SQLite differences:
--   • JSONB → TEXT (SQLite has no native JSON column; JSON.stringify
--     on write, JSON.parse on read in the app layer)
--   • TIMESTAMP → TEXT (ISO 8601 strings, same convention as the rest
--     of the d1 schema)
--   • NOW() → datetime('now')
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_snapshot (
  org_id        TEXT NOT NULL PRIMARY KEY,
  data          TEXT NOT NULL,
  built_from    TEXT NOT NULL,
  built_at      TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
