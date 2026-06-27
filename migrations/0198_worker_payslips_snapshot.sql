-- 0198_worker_payslips_snapshot.sql — D1 / SQLite source for postgres 0198.
-- cache-aside snapshot for the worker
-- portal's GET /api/worker/payslips current-month estimate.
--
-- /payslips is one of the two heaviest worker-portal reads: it runs the labor
-- engine + computeMonthlyEfficiencyByWorker over the current month on every
-- open. The inputs change only when the office keys Working Hours / docks /
-- salary changes or a job card completes — mostly static between reads. A
-- cache-aside snapshot (cache_key = the worker_id + period) gives a near-zero
-- repeat fetch while staying invalidation-safe: the freshness probe takes
-- MAX(updated_at/created_at) across working_hour_entries, payroll_hour_
-- deductions, worker_salary_history and job_cards — any office edit bumps one
-- of those and the next read recomputes.
--
-- Mirrors production_orders_list_snapshot (0135). Lazy recompute-on-READ (never
-- eager-on-write), nightly-wipe philosophy. cache_key = "<worker_id>:<period>".
-- The cached `data` is the full `data` payload the endpoint returns (current +
-- history), already merged.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The table reaches prod ONLY via the runtime self-apply in
-- src/api/routes/worker.ts (ensureWorkerSnapshotTables). This file is the
-- schema source-of-truth / fresh-DB bootstrap; keep the migrations-postgres/0198
-- twin in sync.

CREATE TABLE IF NOT EXISTS worker_payslips_snapshot (
  org_id TEXT NOT NULL, cache_key TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL, built_from TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
