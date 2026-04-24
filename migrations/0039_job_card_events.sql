-- ---------------------------------------------------------------------------
-- 0039_job_card_events.sql — phase 6 event sourcing for job card mutations.
--
-- Parallel write path. The existing `UPDATE job_cards SET ...` continues
-- to happen; every mutation also appends one row here with { from, to }
-- JSON + actor + source. Reads off `job_cards` still work exactly as
-- before. Intended audience: future audit UI + rollback tooling. No
-- historical backfill — forward-only capture from deploy onward.
--
-- eventType enum — minimum set needed to reconstruct the UI state
-- transitions the PATCH handler performs today:
--   STATUS_CHANGED          status: from → to
--   COMPLETED_DATE_SET      completedDate: null → YYYY-MM-DD
--   COMPLETED_DATE_CLEARED  completedDate: YYYY-MM-DD → null
--   PIC_ASSIGNED            pic{1,2}Id: null → id
--   PIC_CLEARED             pic{1,2}Id: id → null
--   DUE_DATE_CHANGED        dueDate: from → to
--   RACK_ASSIGNED           rackingNumber: from → to
--   CREATED                 initial row creation (not wired in phase 6;
--                           reserved for when JC INSERTs start logging)
--   DELETED                 JC hard-delete (reserved; today JCs cascade
--                           via FK, not direct DELETE)
--
-- payload is a JSON blob; we keep it free-form so field-specific extras
-- can ride along without schema churn (e.g. PIC_ASSIGNED carries both
-- picSlot and picName). Callers MUST JSON.stringify before binding.
--
-- Index strategy:
--   idx_jc_events_jc   — "show me every event for this JC"
--   idx_jc_events_po   — "show me every event in this PO's job cards"
--                         (covers the audit-for-a-whole-PO view)
--   idx_jc_events_type — "what STATUS_CHANGED events happened today"
--                         (analytics / cycle-time queries)
--   idx_jc_events_ts   — "recent events across the board" / pruning
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_card_events (
  id TEXT PRIMARY KEY,
  jobCardId TEXT NOT NULL,
  productionOrderId TEXT NOT NULL,
  eventType TEXT NOT NULL CHECK (eventType IN (
    'STATUS_CHANGED','COMPLETED_DATE_SET','COMPLETED_DATE_CLEARED',
    'PIC_ASSIGNED','PIC_CLEARED','DUE_DATE_CHANGED','RACK_ASSIGNED',
    'CREATED','DELETED'
  )),
  payload TEXT NOT NULL,          -- JSON: { from, to, ... }
  actorUserId TEXT,                -- null for system / worker-portal events
  actorName TEXT,
  source TEXT,                     -- 'ui' | 'scan' | 'admin' | 'migration'
  ts TEXT NOT NULL,
  FOREIGN KEY (jobCardId) REFERENCES job_cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jc_events_jc
  ON job_card_events(jobCardId, ts);
CREATE INDEX IF NOT EXISTS idx_jc_events_po
  ON job_card_events(productionOrderId, ts);
CREATE INDEX IF NOT EXISTS idx_jc_events_type
  ON job_card_events(eventType, ts);
CREATE INDEX IF NOT EXISTS idx_jc_events_ts
  ON job_card_events(ts);
