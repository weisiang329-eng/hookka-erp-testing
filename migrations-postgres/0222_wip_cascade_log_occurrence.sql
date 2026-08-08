-- 0222 — wip_cascade_log: the idempotency ticket names an OCCURRENCE, not a
-- transition.
--
-- RECORD ONLY. Deploys do not replay migration files; what actually reaches
-- prod is the runtime self-apply in
-- src/api/routes/production-orders/_helpers.ts (`ensurePendingMigrations`),
-- awaited at the top of the cascade's claim. This file exists so the schema
-- history is complete and a fresh database built from migrations matches.
--
-- WHY
-- The claim key was UNIQUE (org_id, job_card_id, from_status, to_status). A job
-- card completed, reverted to WAITING and completed again therefore collided
-- with its own first ticket: the second WAITING→COMPLETED saw `changes = 0` and
-- returned before applying anything — while the revert's refund had already
-- run. The upstream row keeps the refund it was given (too high) and the
-- stage's own row never gets its producer-add back (too low). 792 job cards on
-- production have been reverted and redone.
--
-- `attempt` counts how many times this exact (from → to) has already been
-- applied to the card, so a genuine re-completion claims a new ticket. A REPLAY
-- is still refused, but now on evidence: the cascade only skips when the card's
-- most recent logged transition is that very same (from → to).
--
-- `seq` gives the log a total order — "what was the last thing we did to this
-- card?" is the whole replay test, and two rows written inside one transaction
-- share `applied_at`.
--
-- Existing rows take attempt = 0 and are already unique on
-- (org_id, job_card_id, from_status, to_status), so the new unique indexes
-- build over live data with no backfill.

ALTER TABLE wip_cascade_log ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wip_cascade_log ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- The old keys are what swallowed the second completion — they must go, not
-- merely be joined by the new ones, or the collision survives.
DROP INDEX IF EXISTS uniq_wip_cascade_log_transition;
DROP INDEX IF EXISTS uniq_wip_cascade_log_initial;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_occurrence
  ON wip_cascade_log (org_id, job_card_id, from_status, to_status, attempt)
  WHERE from_status IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_occurrence_initial
  ON wip_cascade_log (org_id, job_card_id, to_status, attempt)
  WHERE from_status IS NULL;
