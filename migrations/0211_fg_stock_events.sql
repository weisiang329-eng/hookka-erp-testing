-- SQLite mirror of migrations-postgres/0221_fg_stock_events.sql.
-- Column names are snake_case in BOTH dialects (no column-rename-map entry
-- needed). The load-bearing copy is ensureFgStockEventsSchema in
-- src/api/lib/fg-stock-events.ts.

CREATE TABLE IF NOT EXISTS fg_stock_events (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL DEFAULT 'hookka',
  fg_unit_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  direction         INTEGER NOT NULL,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  doc_type          TEXT NOT NULL,
  doc_id            TEXT,
  doc_no            TEXT,
  product_code      TEXT,
  batch_id          TEXT,
  unit_cost_sen     INTEGER,
  occurred_at       TEXT NOT NULL,
  actor_type        TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id          TEXT,
  actor_name        TEXT,
  reverses_doc_type TEXT,
  reverses_doc_id   TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL,
  FOREIGN KEY (fg_unit_id) REFERENCES fg_units(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fg_stock_events_unit    ON fg_stock_events (fg_unit_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_product ON fg_stock_events (product_code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_doc     ON fg_stock_events (doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_org     ON fg_stock_events (org_id);
