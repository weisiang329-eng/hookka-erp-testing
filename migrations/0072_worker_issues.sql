-- ============================================================================
-- HOOKKA ERP — Worker shop-floor issue reports.
--
-- Replaces the in-memory `issueStore` array in src/api/routes-mock/worker.ts.
-- Shop-floor workers tap "Report problem" on /worker, pick a category
-- (MATERIAL / MACHINE / QUALITY / INJURY / OTHER), describe the issue, and
-- optionally attach a phone-camera photo (data-URL). Rows are surfaced to
-- whoever monitors the maintenance / approvals queues.
--
-- workerId is a soft FK to workers(id) — not enforced at the schema level
-- so that an inactive/terminated worker's report history isn't cascaded
-- away on hard-delete (see workers.ts soft-delete defaults).
-- ============================================================================

CREATE TABLE IF NOT EXISTS worker_issues (
  id TEXT PRIMARY KEY,
  workerId TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  photoDataUrl TEXT,
  reportedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'OPEN'
);

CREATE INDEX IF NOT EXISTS idx_worker_issues_workerId
  ON worker_issues(workerId, reportedAt DESC);
