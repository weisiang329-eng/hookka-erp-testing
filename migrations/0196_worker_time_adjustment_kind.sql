-- ============================================================================
-- HOOKKA ERP — Time-adjustment: extend worker_nonprod_requests into a unified
-- "Time adjustment" request (owner 2026-06-26, additive on top of 0110).
--
-- The 0110 table only modelled NON-production hours (helping R&D etc.), which
-- PROTECT efficiency by leaving the denominator (those hours land in a non-prod
-- working_hour_entries row, which the efficiency denominator excludes).
--
-- NEW: a worker may also claim EXTRA PRODUCTION TIME on a PRODUCTION department
-- — e.g. a customize job whose WIP standard was 1h actually took 3h, so the
-- worker claims +2h of production time in Upholstery. Admin approves and that
-- extra time COUNTS AS PRODUCTION OUTPUT (added to the efficiency NUMERATOR for
-- that worker), so efficiency stays fair.
--
-- Two new columns (snake_case — the safe pattern, NO column-rename-map entry):
--   kind         TEXT NOT NULL DEFAULT 'NONPROD'  -- 'NONPROD' | 'ADD_PROD'
--   job_card_id  TEXT NULL                        -- optional WIP/job ref for ADD_PROD
--
-- The existing hours / department_code / note columns are reused as-is. For
-- ADD_PROD, department_code holds a PRODUCTION dept's code and hours holds the
-- extra production hours claimed.
--
-- INTEGRATION (the careful part): ADD_PROD does NOT write a working_hour_entries
-- row (that would inflate the DENOMINATOR and defeat the purpose). Instead, the
-- approved ADD_PROD hours are read at efficiency-compute time and added to the
-- credited production minutes (the NUMERATOR) for that worker on that date/dept.
-- NONPROD behaviour is UNCHANGED.
--
-- NOTE: this migration file is INERT on deploy — Hookka does not auto-replay
-- migrations. The runtime self-apply (ensureNonprodRequests in
-- src/api/routes/worker.ts) runs these ALTER … ADD COLUMN IF NOT EXISTS before
-- the first read/write, which is what actually reaches prod. A pre-existing
-- 0110 row gets kind='NONPROD' (the DEFAULT) and job_card_id=NULL — byte-
-- identical behaviour for every request already in the table.
-- ============================================================================

ALTER TABLE worker_nonprod_requests
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'NONPROD';

ALTER TABLE worker_nonprod_requests
  ADD COLUMN IF NOT EXISTS job_card_id TEXT;
