-- 0104_co_status_changes.sql
--
-- Audit table for Consignment Order status transitions, mirroring
-- so_status_changes (migrations-postgres/0001_init.sql:1457). Until this
-- table existed, every CO transition fired silently — operators couldn't
-- see who flipped a CO from READY_TO_SHIP back to IN_PRODUCTION, or
-- which CN dispatch chain bumped it to DELIVERED.
--
-- Writes flow from cascadeUpholsteryToCO and cascadeCNCompletionToCO /
-- cascadeCNReversalToCO (production-orders.ts), matching the so audit
-- writes from cascadeUpholsteryToSO / cascadePoCompletionToSO.

CREATE TABLE IF NOT EXISTS co_status_changes (
  id TEXT PRIMARY KEY,
  co_id TEXT,
  from_status TEXT,
  to_status TEXT,
  changed_by TEXT,
  timestamp TEXT NOT NULL,
  notes TEXT,
  auto_actions TEXT,  -- JSON string[]
  org_id TEXT NOT NULL DEFAULT 'hookka',
  FOREIGN KEY (co_id) REFERENCES consignment_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_co_status_changes_co_id     ON co_status_changes(co_id);
CREATE INDEX IF NOT EXISTS idx_co_status_changes_timestamp ON co_status_changes(timestamp);
CREATE INDEX IF NOT EXISTS idx_co_status_changes_org_id    ON co_status_changes(org_id);
