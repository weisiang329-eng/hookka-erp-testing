-- ============================================================================
-- Phase B.4 — file_assets (Postgres mirror of D1 migrations/0055_file_assets.sql).
--
-- Schema parity notes (see migrations-postgres/0053_oauth_identities.sql for
-- the full convention rundown):
--   * Column names are snake_case here, camelCase in the D1 source. The
--     D1Compat adapter handles the rename at query time
--     (src/api/lib/column-rename-map.json).
--   * Timestamps are TIMESTAMPTZ default now() (vs TEXT ISO 8601 in D1).
-- ============================================================================

CREATE TABLE IF NOT EXISTS file_assets (
  id            TEXT        PRIMARY KEY,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  filename      TEXT        NOT NULL,
  content_type  TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL,
  r2_key        TEXT        NOT NULL,
  uploaded_by   TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  org_id        TEXT        NOT NULL DEFAULT 'hookka'
);

CREATE INDEX IF NOT EXISTS idx_file_assets_resource
  ON file_assets(resource_type, resource_id, org_id);

CREATE INDEX IF NOT EXISTS idx_file_assets_org_uploaded
  ON file_assets(org_id, uploaded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_r2key
  ON file_assets(r2_key);
