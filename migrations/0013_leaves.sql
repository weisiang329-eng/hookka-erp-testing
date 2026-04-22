-- ============================================================================
-- HOOKKA ERP — Leave records
--
-- Tracks leave requests for each worker (ANNUAL / MEDICAL / UNPAID / EMERGENCY
-- / PUBLIC_HOLIDAY). Status flows PENDING -> APPROVED / REJECTED.
--
-- workerId is an FK to workers(id) but intentionally not enforced with
-- REFERENCES because legacy leave rows may pre-date the workers row they
-- point at (mock-data bootstraps workers after leaves in some reseed flows).
-- The route layer validates the FK on insert.
-- ============================================================================

CREATE TABLE IF NOT EXISTS leaves (
  id           TEXT PRIMARY KEY,
  workerId     TEXT NOT NULL,
  workerName   TEXT NOT NULL,
  type         TEXT NOT NULL,          -- ANNUAL | MEDICAL | UNPAID | EMERGENCY | PUBLIC_HOLIDAY
  startDate    TEXT NOT NULL,          -- YYYY-MM-DD
  endDate      TEXT NOT NULL,          -- YYYY-MM-DD
  days         INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED
  reason       TEXT NOT NULL DEFAULT '',
  approvedBy   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_leaves_workerId ON leaves(workerId);
CREATE INDEX IF NOT EXISTS idx_leaves_status   ON leaves(status);
CREATE INDEX IF NOT EXISTS idx_leaves_startDate ON leaves(startDate);
