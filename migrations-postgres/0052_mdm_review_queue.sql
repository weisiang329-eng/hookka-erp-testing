-- ---------------------------------------------------------------------------
-- 0052_mdm_review_queue.sql — Postgres mirror of migrations/0052.
--
-- Per docs/d1-retirement-plan.md the live data lives in Supabase, not D1.
-- D1 migration files are kept for parity / rollback only; the actual DDL
-- runs against Postgres via supabase CLI or psql, in snake_case.
--
-- See migrations/0052_mdm_review_queue.sql for design rationale (Phase C #4
-- quick-win — duplicate-detection review queue, detection only, no merge).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mdm_review_queue (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  signals TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'PENDING',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  notes TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT 'hookka',
  UNIQUE (resource_type, primary_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_mdm_status   ON mdm_review_queue(status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_mdm_resource ON mdm_review_queue(resource_type, status);
