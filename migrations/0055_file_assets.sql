-- ============================================================================
-- Phase B.4 — file_assets table.
--
-- Tracks every uploaded file (invoice PDF, BOM technical drawing, SO
-- attachment) along with the R2 object key. The R2 binding is named
-- FILES (see wrangler.toml block under "Phase B.4"); the actual bytes
-- live in r2://hookka-files/<orgId>/<resourceType>/<resourceId>/...
--
-- Columns:
--   id            — fa-<uuid12> string id
--   resourceType  — kind of resource the file is attached to
--                   ('invoice' | 'bom' | 'sales-order' | 'rd-project' | ...)
--   resourceId    — id within that resource type
--   filename      — original filename as uploaded (for display + download)
--   contentType   — MIME type as reported by the upload
--   sizeBytes     — file size in bytes (cached so listing doesn't HEAD R2)
--   r2Key         — full R2 object key (orgId/resourceType/resourceId/id-name)
--   uploadedBy    — userId from the auth-middleware context (nullable for
--                   system-generated files like cron-built backups)
--   uploadedAt    — ISO 8601 timestamp at upload completion
--   orgId         — multi-tenant scope (Phase C #1) — defaults to 'hookka'
--                   for backwards compatibility with the single-tenant rollout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS file_assets (
  id TEXT PRIMARY KEY,
  resourceType TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  filename TEXT NOT NULL,
  contentType TEXT NOT NULL,
  sizeBytes INTEGER NOT NULL,
  r2Key TEXT NOT NULL,
  uploadedBy TEXT,
  uploadedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  orgId TEXT NOT NULL DEFAULT 'hookka'
);

-- Lookup by (resource, org) is the dominant query pattern:
-- "show me all files attached to invoice INV-123" or
-- "every BOM drawing under org=hookka". Composite index covers both.
CREATE INDEX IF NOT EXISTS idx_file_assets_resource
  ON file_assets(resourceType, resourceId, orgId);

-- Org-scoped listing for the admin file browser.
CREATE INDEX IF NOT EXISTS idx_file_assets_org_uploaded
  ON file_assets(orgId, uploadedAt DESC);

-- R2 key uniqueness — guards against accidental double-inserts where
-- two rows would point at the same object.
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_assets_r2key
  ON file_assets(r2Key);
