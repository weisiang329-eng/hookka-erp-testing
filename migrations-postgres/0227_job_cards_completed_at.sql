-- 0227_job_cards_completed_at.sql
--
-- BUG-2026-08-13-103 — the factory cannot measure how long any job takes,
-- because the system throws the time away at the moment of capture.
--
-- Measured on prod 2026-08-14:
--   · job_cards.distributed_at = '2026-08-13T01:03:11.395Z'  — a FULL instant,
--     100% populated;
--   · job_cards.completed_date = '2026-08-14'                — date only.
-- Fourteen `.slice(0, 10)` / `split("T")[0]` truncations across the production
-- and worker write paths discard a full ISO timestamp that was already in
-- scope. Elapsed time per card is therefore not derivable, and every
-- "production time" column is the ESTIMATE standing in for a measurement:
-- production_time_minutes = est_minutes on all 36,796 rows (0 differ), and
-- actual_minutes = est_minutes on 100% of the rows that carry a value.
--
-- ⚠ THIS FILE IS A RECORD, NOT THE MECHANISM. Deploys in this repo do NOT
-- replay migrations-postgres/*.sql — a migration file alone is INERT on prod.
-- The load-bearing copy is the runtime self-apply in
-- src/api/lib/job-card-completed-at.ts (`ensureJobCardCompletedAt`), awaited at
-- the top of every handler that writes the column, before the first statement
-- that mentions it. Keep the two in step; this file exists so the schema
-- history is readable and a database built from the migrations matches prod.
--
-- ADDITIVE ONLY. `completed_date` is NOT changed, NOT dropped and NOT
-- reinterpreted — its date-only semantics and shape are depended on by the
-- efficiency scan, the department sheets, the job-card list filters, the
-- archive union and every `substr(completedDate::text, 1, 10)` comparison in
-- the agent-learning queries.
--
-- TEXT, not TIMESTAMPTZ, on purpose: the value this column exists to be
-- subtracted FROM is job_cards.distributed_at, which is TEXT holding an ISO-8601
-- instant. One shape on both sides keeps the duration maths a plain parse of two
-- identical formats and keeps SELECT * rows uniformly string|null.
--
-- Nullable, and NOT backfilled. The time is already gone for existing rows;
-- inventing one would be fabrication (BUG-CLASSES C15 — a figure that reads as
-- measured and is not). NULL is readable as "not measured". Real durations
-- become computable only for cards completed AFTER this ships.

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_job_cards_completed_at
  ON job_cards (completed_at);
