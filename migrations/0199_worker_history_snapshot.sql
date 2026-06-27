-- 0199_worker_history_snapshot.sql — D1 / SQLite source for postgres 0199.
--
-- cache-aside snapshot for the worker portal's GET /api/worker/history.
-- /history is the other heavy worker-portal read: attendance + working-hour
-- rollup + completed-job-card share calc + computeMonthlyEfficiencyByWorker
-- over the selected [from,to] range, on every range change. Same lazy
-- freshness pattern as 0198: cache_key = "<worker_id>:<from>:<to>"; the
-- freshness probe takes MAX across attendance_records, working_hour_entries,
-- job_cards, piece_pics and worker_nonprod_requests — any office/floor edit
-- bumps one and the next read recomputes. Backend only; the front-end already
-- refetches on range change.
--
-- Mirrors production_orders_list_snapshot (0135). Lazy recompute-on-READ.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The table reaches prod ONLY via the runtime self-apply in
-- src/api/routes/worker.ts (ensureWorkerSnapshotTables). Keep the
-- migrations-postgres/0199 twin in sync.

CREATE TABLE IF NOT EXISTS worker_history_snapshot (
  org_id TEXT NOT NULL, cache_key TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL, built_from TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, cache_key)
);
