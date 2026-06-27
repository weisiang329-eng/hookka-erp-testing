-- 0197_worker_portal_perf_indices.sql
--
-- Worker-portal speed-up (owner 2026-06-27: "the worker portal loads slowly").
-- Indices supporting the two heaviest reads, GET /api/worker/history and
-- GET /api/worker/payslips (both run computeMonthlyEfficiencyByWorker):
--
--   • job_cards(completed_date)        — the efficiency / completed-card scan
--     filters job_cards on completedDate (range) repeatedly. No index existed.
--   • attendance_records(employee_id, date) — /history filters
--     `employeeId = ? AND date BETWEEN ? AND ?`. Single-column employee_id and
--     date indices exist, but no COMPOSITE that serves the combined predicate.
--
-- NOT added (already present — verified against 0001_init.sql):
--   • piece_pics(job_card_id)          — idx_piece_pics_jc already covers it.
--
-- NOTE: Hookka deploys do NOT replay migration files — this file is INERT on
-- prod. The indices reach prod ONLY via the runtime self-apply in
-- src/api/routes/worker.ts (ensureWorkerPerfIndices, awaited at the top of the
-- /history + /payslips handlers). This file is the schema source-of-truth /
-- fresh-DB bootstrap; keep the migrations-postgres/0197 twin in sync.

CREATE INDEX IF NOT EXISTS idx_job_cards_completed_date
  ON job_cards (completed_date);

CREATE INDEX IF NOT EXISTS idx_attendance_employee_date
  ON attendance_records (employee_id, date);
