-- 0021_cost_ledger_wip_type.sql
--
-- Extend the cost_ledger.type CHECK constraint to include 'WIP_COMPLETED'.
--
-- The original schema (0001_init.sql) only allowed
--   RM_RECEIPT / RM_ISSUE / LABOR_POSTED / FG_COMPLETED / FG_DELIVERED /
--   ADJUSTMENT
-- but Track F4 in src/api/lib/po-cost-cascade.ts now emits WIP_COMPLETED
-- rows directly (replacing the old ADJUSTMENT-with-"WIP_COMPLETED"-prefix
-- hack). Without this migration, postWIPCompletionMarker() would fail with
-- a CHECK constraint violation on every PO completion.
--
-- SQLite can't ALTER an existing CHECK constraint — the only way is to
-- rebuild the table. D1 forbids explicit BEGIN/COMMIT (the platform
-- wraps every --file execution atomically on our behalf), so the
-- statements below run sequentially and roll back as a unit on failure.

-- 1. Rename existing table out of the way.
ALTER TABLE cost_ledger RENAME TO cost_ledger_old;

-- 2. Re-create with extended CHECK constraint.
CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'RM_RECEIPT',
    'RM_ISSUE',
    'LABOR_POSTED',
    'FG_COMPLETED',
    'FG_DELIVERED',
    'ADJUSTMENT',
    'WIP_COMPLETED'
  )),
  item_type TEXT NOT NULL CHECK (item_type IN ('RM','WIP','FG')),
  item_id TEXT NOT NULL,
  batch_id TEXT,
  qty DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  unit_cost_sen INTEGER NOT NULL,
  total_cost_sen INTEGER NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  notes TEXT
);

-- 3. Copy data back.
INSERT INTO cost_ledger
  (id, date, type, item_type, item_id, batch_id, qty, direction,
   unit_cost_sen, total_cost_sen, ref_type, ref_id, notes)
SELECT
  id, date, type, item_type, item_id, batch_id, qty, direction,
  unit_cost_sen, total_cost_sen, ref_type, ref_id, notes
FROM cost_ledger_old;

-- 4. Drop the old table.
DROP TABLE cost_ledger_old;

-- 5. Recreate indexes (present on original table in 0001_init.sql).
CREATE INDEX IF NOT EXISTS idx_cost_ledger_date ON cost_ledger(date);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_item_type ON cost_ledger(item_type);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_item_id ON cost_ledger(item_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_type ON cost_ledger(type);
