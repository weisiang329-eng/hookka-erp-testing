-- ---------------------------------------------------------------------------
-- 0090_rd_projects_draft_status.sql
--
-- R&D Project: introduce a "DRAFT" status so newly captured 款式 / design
-- ideas land in a backlog instead of jumping straight into the live
-- Pipeline kanban. The shop owner only wants Pipeline to show projects
-- they've explicitly committed to ("开启"), not every random idea
-- someone typed in.
--
-- Lifecycle after this migration:
--   DRAFT     ← new ideas land here. Visible only on the "Drafts" tab.
--   ACTIVE    ← flipped via POST /api/rd-projects/:id/start. Shows up in
--               the Pipeline kanban + the Projects tab.
--   ON_HOLD   ← paused after activation. Still in Pipeline.
--   COMPLETED ← finished R&D, moved to production-ready.
--   CANCELLED ← killed.
--
-- Existing rows keep whatever status they already have (ACTIVE / ON_HOLD /
-- COMPLETED / CANCELLED). Only the CHECK constraint widens. We also add a
-- nullable `started_at` so we can later show "in pipeline since X" or
-- compute idea-to-active lead time.
--
-- IDEMPOTENT: re-running this migration is safe — DROP CONSTRAINT IF
-- EXISTS, ADD COLUMN IF NOT EXISTS, etc.
-- ---------------------------------------------------------------------------

-- 1. Widen the status CHECK to allow 'DRAFT'.
ALTER TABLE rd_projects DROP CONSTRAINT IF EXISTS rd_projects_status_check;
ALTER TABLE rd_projects
  ADD CONSTRAINT rd_projects_status_check
  CHECK (status IN ('DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'));

-- 2. New rows default to DRAFT. Existing rows are untouched (the column
--    already has values), so this only affects future INSERTs that omit
--    `status`. The API also passes 'DRAFT' explicitly going forward.
ALTER TABLE rd_projects ALTER COLUMN status SET DEFAULT 'DRAFT';

-- 3. Activation timestamp. Set the moment a project is flipped DRAFT →
--    ACTIVE. Used for "in pipeline since X" + lead-time analytics.
ALTER TABLE rd_projects
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- 4. Backfill: any project not currently DRAFT must already have been
--    "started" — we don't know the real timestamp, so fall back to the
--    creation date. This avoids NULL `started_at` for legacy ACTIVE rows
--    (matters for the "in pipeline since" UI label).
UPDATE rd_projects
   SET started_at = COALESCE(
         created_date::timestamptz,
         NOW()
       )
 WHERE started_at IS NULL
   AND status <> 'DRAFT';

-- 5. Index for the Drafts-tab query: list all DRAFT rows ordered by
--    created date (newest first). Partial index so it stays tiny — most
--    rows are in non-DRAFT statuses, no point indexing them here.
CREATE INDEX IF NOT EXISTS idx_rd_projects_drafts_recent
  ON rd_projects (created_date DESC)
  WHERE status = 'DRAFT';
