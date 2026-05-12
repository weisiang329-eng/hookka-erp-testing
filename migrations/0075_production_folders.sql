-- ============================================================================
-- HOOKKA ERP — Production Folders: archive paper-schedule snapshots.
--
-- Operator workflow problem (Wei Siang 2026-05-12):
--   "我把 Production Schedule 打印出来交给他们后，如果任务完成了，我标记
--    completetion and PIC的名字，但之后想找回这些记录时会找得很辛苦"
--
-- Solution: lightweight folder = named list of job_card ids. The operator
-- multi-selects rows on the Production page, names a folder ("2026-05-13
-- Wood Cut"), prints, and later opens that folder to find every JC on
-- that sheet in one click. No JC data is duplicated — folder rows just
-- reference job_cards.id, so subsequent edits stay live.
--
-- ON DELETE CASCADE on folder_id means deleting a folder cleans its rows;
-- deleting a JC does NOT cascade into folder_job_cards (folder may legitimately
-- outlive a JC delete — keep the row, treat it as a dangling pointer the UI
-- surfaces or filters).
-- ============================================================================

CREATE TABLE IF NOT EXISTS production_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folder_job_cards (
  folder_id   UUID NOT NULL REFERENCES production_folders(id) ON DELETE CASCADE,
  job_card_id TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, job_card_id)
);

CREATE INDEX IF NOT EXISTS idx_production_folders_org_created
  ON production_folders (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_folder_job_cards_jc
  ON folder_job_cards (job_card_id);
