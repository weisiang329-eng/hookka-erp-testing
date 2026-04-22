-- ---------------------------------------------------------------------------
-- 0026_po_scan_samples.sql
--
-- Audit + few-shot buffer for the Claude-powered Customer PO OCR flow.
--
-- Every POST /api/scan-po/extract inserts a row with `rawExtracted` set to
-- the first-pass JSON Claude returned (or an error blob when the Anthropic
-- API call failed). When the user edits the preview and confirms creation
-- via POST /api/scan-po/samples/:id/confirm, `correctedJson` is filled in
-- with the user-corrected payload. That corrected JSON is looked up as a
-- few-shot example for subsequent extraction calls to improve accuracy
-- for future POs. `customerHint` and `poIdentifier` are best-effort
-- metadata for search/debugging.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS po_scan_samples (
  id TEXT PRIMARY KEY,
  customerHint TEXT,
  poIdentifier TEXT,
  rawExtracted TEXT,
  correctedJson TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  createdBy TEXT
);

CREATE INDEX IF NOT EXISTS idx_po_scan_customer ON po_scan_samples(customerHint);
CREATE INDEX IF NOT EXISTS idx_po_scan_created ON po_scan_samples(createdAt DESC);
