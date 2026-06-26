-- ============================================================================
-- HOOKKA ERP — Worker non-production hours APPLY + APPROVE.
--
-- A worker who spent part of a day on NON-PRODUCTION work (helping R&D, repair,
-- warehouse, maintenance, shortfall) produces no Production Time, so their
-- efficiency = production minutes / (PRODUCTION-dept working hours × 60) looks
-- unfairly low. The fix is purely additive: the worker APPLIES for "X hours in
-- <non-prod dept> on <date>"; an admin APPROVES from the Working Hours screen;
-- on approve a normal working_hour_entries row is written attributing those
-- hours to the non-production department. Because the efficiency denominator
-- already counts ONLY isProduction depts (see src/api/lib/efficiency-allowance.ts),
-- those approved hours are EXCLUDED from the denominator → the denominator drops
-- → efficiency rises, with ZERO change to the efficiency or pay formulas.
--
-- All columns are snake_case (the safe pattern — no column-rename-map entry
-- needed). NOTE: this migration file is INERT on deploy — Hookka does not
-- auto-replay migrations. The runtime self-apply (ensureNonprodRequests in
-- src/api/routes/worker.ts) creates this table via CREATE TABLE IF NOT EXISTS
-- before the first read/write, which is what actually reaches prod.
--
-- worker_id / decided_by are soft FKs (workers(id) / users(id)) — not enforced
-- so an inactive worker's request history isn't cascaded away on hard-delete.
-- ============================================================================

CREATE TABLE IF NOT EXISTS worker_nonprod_requests (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  date TEXT NOT NULL,                 -- YYYY-MM-DD the non-prod work happened
  department_code TEXT NOT NULL,      -- a NON-production departments.code (R_AND_D, REPAIR, …)
  hours DOUBLE PRECISION NOT NULL,    -- decimal hours, e.g. 2 or 1.5
  note TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  decided_by TEXT,
  -- The working_hour_entries row written on APPROVE, so an un-approve / audit
  -- can find it. NULL until approved.
  entry_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_nonprod_requests_worker
  ON worker_nonprod_requests(worker_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_worker_nonprod_requests_status
  ON worker_nonprod_requests(status, created_at DESC);
