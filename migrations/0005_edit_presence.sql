-- ============================================================================
-- HOOKKA ERP — edit_presence
--
-- Lightweight "who's editing what right now" table. Populated by clients
-- that open an edit view; each holder posts a heartbeat every 30s while the
-- view is mounted. A holder is considered active if heartbeatAt is within
-- the last 60s. On save or unmount the client sends DELETE.
--
-- No FK to users — we store displayName + userId directly so stale rows
-- from long-gone users still render sensibly until the 60s window expires.
-- ============================================================================

CREATE TABLE edit_presence (
  id TEXT PRIMARY KEY,
  recordType TEXT NOT NULL,   -- 'sales_order' | 'delivery_order' | 'purchase_order' | ...
  recordId TEXT NOT NULL,
  userId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  acquiredAt TEXT NOT NULL,
  heartbeatAt TEXT NOT NULL
);

-- One active row per (recordType, recordId, userId) — a heartbeat just
-- bumps heartbeatAt.
CREATE UNIQUE INDEX idx_edit_presence_unique
  ON edit_presence(recordType, recordId, userId);

CREATE INDEX idx_edit_presence_lookup
  ON edit_presence(recordType, recordId, heartbeatAt);

CREATE INDEX idx_edit_presence_sweep
  ON edit_presence(heartbeatAt);
