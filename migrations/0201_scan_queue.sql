-- ---------------------------------------------------------------------------
-- Background scan queue — async OCR processing for scan-po + scan-supplier.
--
-- Today's scan flow synchronously holds the HTTP connection while Claude
-- vision runs (90-180s per file). Closing the tab kills the request. This
-- table backs an async batch:
--   1. POST /api/scan-queue/upload returns IMMEDIATELY with batchId, queues
--      rows. waitUntil() drives processBatch() server-side.
--   2. /scan-queue/<batchId> polls /api/scan-queue/batch/:batchId every 5s.
--   3. Same file (SHA-256 of bytes) re-uploaded ⇒ instant cache hit reusing
--      the prior 'done' row's raw_json (zero Claude calls).
--
-- Created at runtime by `ensureScanQueueTable` in routes/scan-queue.ts via
-- CREATE TABLE / CREATE INDEX IF NOT EXISTS — this file is the historical
-- record; deploy does NOT auto-apply migration files (see CLAUDE.md).
--
-- file_bytes_b64: temporary stash of the raw file bytes until R2 / Supabase
-- Storage is wired in. Workers can hold a 32MB base64 string in JSONB fine;
-- when the row's status flips to 'done' the processor NULLs file_bytes_b64
-- so the table doesn't grow unbounded. Cache hits never write the bytes
-- (the prior 'done' row already has raw_json).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_queue (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,          -- 'po' | 'supplier'
  file_hash       TEXT NOT NULL,          -- SHA-256 hex of bytes (cache key)
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  file_bytes_b64  TEXT,                   -- nulled once 'done' (or 'cached')
  supplier_id     TEXT,                   -- supplier hint (supplier scans only)
  po_context      TEXT,                   -- optional PO context (supplier scans)
  status          TEXT NOT NULL,          -- 'queued'|'processing'|'done'|'failed'|'cached'
  raw_json        JSONB,                  -- ExtractionResult JSON when done
  error           TEXT,
  cache_source_id TEXT,                   -- when status='cached', the source 'done' row
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  org_id          TEXT
);
CREATE INDEX IF NOT EXISTS scan_queue_batch_idx  ON scan_queue (batch_id);
CREATE INDEX IF NOT EXISTS scan_queue_status_idx ON scan_queue (status, created_at);
CREATE INDEX IF NOT EXISTS scan_queue_hash_idx   ON scan_queue (file_hash);
