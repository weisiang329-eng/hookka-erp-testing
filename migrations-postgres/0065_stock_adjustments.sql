-- ============================================================================
-- Migration 0065 — Stock Adjustments table.
--
-- Manual stock corrections for WIP / FG / Raw Material inventory. Each row
-- is paired with:
--   1. A stock_movements entry (audit ledger — "what physically changed")
--   2. A cost_ledger entry of type='ADJUSTMENT' (financial impact —
--      "how much money was added/written off")
--
-- Per user 2026-04-28:
--   • No approver — direct effect, but ALWAYS record who/when/why.
--   • Reason is mandatory; the dropdown values match the CHECK below.
--   • Cost impact MUST be tracked — shown as totalCostSen (absolute) on
--     the stocks side; cost_ledger.direction (IN/OUT) tracks the sign.
-- ============================================================================

CREATE TABLE stock_adjustments (
  id TEXT PRIMARY KEY,
  -- WIP / FG / RM — which inventory pool was touched. Drives FK lookups
  -- and determines which downstream table gets its qty updated.
  type TEXT NOT NULL CHECK (type IN ('RM','WIP','FG')),
  -- For RM: raw_materials.id
  -- For WIP: wip_items.id
  -- For FG: fg_batches.id (batch-level adjustment — if individual fg_units
  --        need correction, the user marks their status RETURNED via the
  --        existing fg-units flow instead).
  item_id TEXT NOT NULL,
  item_code TEXT NOT NULL,             -- denormalised display key
  item_name TEXT,
  -- Signed qty delta. Positive = add to stock (FOUND, RETURN). Negative
  -- = remove (DAMAGED, WRITE_OFF). DOUBLE PRECISION because RM may use
  -- fractional qty (metres, kg).
  qty_delta DOUBLE PRECISION NOT NULL,
  -- Per-unit cost at the moment of the adjustment. For RM positive
  -- delta this is operator-provided; for negative delta it is
  -- weighted-avg from existing rm_batches. WIP/FG values come from
  -- the parent item's last cost_ledger entry.
  unit_cost_sen INTEGER NOT NULL DEFAULT 0,
  -- |qtyDelta| × unitCostSen — absolute money value of the adjustment,
  -- mirrored into cost_ledger.totalCostSen with the matching direction.
  total_cost_sen INTEGER NOT NULL DEFAULT 0,
  -- IN = inventory increased (operator found stock or unit returned)
  -- OUT = inventory decreased (damaged / write-off / count down). Derived
  -- from the sign of qtyDelta on the API side; stored explicitly for
  -- direct filtering without arithmetic.
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  -- Reason taxonomy — keep aligned with the UI dropdown. Adding new
  -- values requires updating BOTH the CHECK above AND the
  -- /inventory/adjustments page's dropdown.
  reason TEXT NOT NULL CHECK (reason IN (
    'FOUND','DAMAGED','COUNT_CORRECTION','WRITE_OFF','OTHER'
  )),
  notes TEXT,
  adjusted_by TEXT,
  adjusted_by_name TEXT,
  adjusted_at TEXT NOT NULL,
  created_at TEXT
);

-- Per-item lookup so the inventory pages can show "last 10 adjustments
-- for this row" cheaply.
CREATE INDEX idx_stock_adjustments_item_id ON stock_adjustments(item_id);
CREATE INDEX idx_stock_adjustments_type ON stock_adjustments(type);
CREATE INDEX idx_stock_adjustments_adjusted_at ON stock_adjustments(adjusted_at);
