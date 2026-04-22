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
  itemType TEXT NOT NULL CHECK (itemType IN ('RM','WIP','FG')),
  itemId TEXT NOT NULL,
  batchId TEXT,
  qty REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  unitCostSen INTEGER NOT NULL,
  totalCostSen INTEGER NOT NULL,
  refType TEXT,
  refId TEXT,
  notes TEXT
);

-- 3. Copy data back.
INSERT INTO cost_ledger
  (id, date, type, itemType, itemId, batchId, qty, direction,
   unitCostSen, totalCostSen, refType, refId, notes)
SELECT
  id, date, type, itemType, itemId, batchId, qty, direction,
  unitCostSen, totalCostSen, refType, refId, notes
FROM cost_ledger_old;

-- 4. Drop the old table.
DROP TABLE cost_ledger_old;

-- 5. Recreate indexes (present on original table in 0001_init.sql).
CREATE INDEX IF NOT EXISTS idx_cost_ledger_date ON cost_ledger(date);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_itemType ON cost_ledger(itemType);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_itemId ON cost_ledger(itemId);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_type ON cost_ledger(type);
