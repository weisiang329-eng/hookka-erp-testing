-- 0022_scan_override_audit.sql
--
-- Audit trail for worker-forced scan overrides.
--
-- When a worker hits PREREQUISITE_NOT_MET or UPSTREAM_LOCKED on the
-- shop-floor scanner, the server now returns a SOFT warning (HTTP 202,
-- requiresConfirmation=true) instead of a hard reject. If the worker
-- acknowledges the warning and re-posts with `force: true`, the scan
-- proceeds AND a row lands here so we can trace who forced what and when.
--
-- Also extends cost_ledger with a workerId column (nullable) so the F2
-- labor posting can attribute minutes to each PIC on a job card — when
-- two workers share a piece, each worker now gets their own LABOR_POSTED
-- row for their share of the job-card minutes.

CREATE TABLE IF NOT EXISTS scan_override_audit (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  workerName TEXT,
  jobCardId TEXT NOT NULL,
  productionOrderId TEXT NOT NULL,
  overrideCode TEXT NOT NULL CHECK (overrideCode IN ('PREREQUISITE_NOT_MET','UPSTREAM_LOCKED')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scan_override_worker ON scan_override_audit(workerId);
CREATE INDEX IF NOT EXISTS idx_scan_override_jc ON scan_override_audit(jobCardId);

-- Add workerId to cost_ledger (nullable — legacy rows and non-labor rows
-- leave it null). ALTER TABLE ADD COLUMN works on sqlite/D1 without a
-- table rebuild as long as the new column is NULLABLE with no UNIQUE or
-- foreign-key constraint attached.
ALTER TABLE cost_ledger ADD COLUMN workerId TEXT;
CREATE INDEX IF NOT EXISTS idx_cost_ledger_workerId ON cost_ledger(workerId);
