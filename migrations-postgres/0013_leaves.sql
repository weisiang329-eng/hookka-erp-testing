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
  worker_id     TEXT NOT NULL,
  worker_name   TEXT NOT NULL,
  type         TEXT NOT NULL,          -- ANNUAL | MEDICAL | UNPAID | EMERGENCY | PUBLIC_HOLIDAY
  start_date    TEXT NOT NULL,          -- YYYY-MM-DD
  end_date      TEXT NOT NULL,          -- YYYY-MM-DD
  days         INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED
  reason       TEXT NOT NULL DEFAULT '',
  approved_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at   TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
);

CREATE INDEX IF NOT EXISTS idx_leaves_worker_id ON leaves(worker_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status   ON leaves(status);
CREATE INDEX IF NOT EXISTS idx_leaves_start_date ON leaves(start_date);
