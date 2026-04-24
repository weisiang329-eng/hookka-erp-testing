-- ---------------------------------------------------------------------------
-- 0037_perf_indexes.sql — phase 3 hot-path composite / covering indexes.
--
-- Context: ~8,900 job_cards, ~530 production_orders, ~350 sales_orders in
-- prod. "Everything is slow" report. Every index below backs a real query
-- confirmed by grep — nothing speculative.
--
-- Budget: SQLite soft cap ~10 indexes/table. After this migration:
--   job_cards          : 6 → 8
--   production_orders  : 4 → 5
--   cost_ledger        : 4 → 5
--   fg_units           : 4 → 5
--   wip_items          : 0 → 1
-- All comfortably under budget.
--
-- Idempotent: every CREATE INDEX uses IF NOT EXISTS so re-applying is safe.
-- ---------------------------------------------------------------------------

-- Backs job-card lookups filtered by (PO + department):
--   * cascadeUpholsteryToSO  — "WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (...)"
--   * /scan-complete-dept   — "WHERE productionOrderId = ? AND departmentCode = ?"
--   * SO confirm JC lookup  — filter by (PO + dept)
-- Replaces the need for SQLite to fall back from idx_jc_poId and filter
-- departmentCode in-memory across every JC row for that PO.
CREATE INDEX IF NOT EXISTS idx_jc_po_dept
  ON job_cards(productionOrderId, departmentCode);

-- Backs (PO + wipKey) chain scans:
--   * upstream-lock check in applyPoUpdate / scan-complete
--       "WHERE productionOrderId = ? AND wipKey = ? AND sequence > ? AND status IN (...)"
--   * jobcard-sync "SELECT wipKey, departmentCode FROM job_cards WHERE productionOrderId = ?"
--     (covered by leading column already, but composite lets promise-date +
--     production-leadtimes aggregate by wipKey without a per-row sort)
--   * production-leadtimes /promise-date JC-chain traversals
CREATE INDEX IF NOT EXISTS idx_jc_po_wipKey
  ON job_cards(productionOrderId, wipKey);

-- Backs the sofa sibling lookup inside applyWipInventoryChange:
--   "FROM production_orders po WHERE po.salesOrderId = ? AND po.fabricCode = ?
--        AND po.itemCategory = 'SOFA'"
-- Fires on every FAB_SEW IN_PROGRESS scan for a sofa PO. Currently the
-- leading idx_prod_po_salesOrderId narrows the range but we still scan each
-- sibling PO row to compare fabricCode.
CREATE INDEX IF NOT EXISTS idx_prod_po_so_fabric
  ON production_orders(salesOrderId, fabricCode);

-- Backs every cost_ledger idempotency / rollup query in po-cost-cascade.ts
-- and do-cost-cascade.ts:
--   "WHERE refType = 'PRODUCTION_ORDER' AND refId = ? AND type = 'RM_ISSUE'"
--   "WHERE type = 'LABOR_POSTED' AND refType = 'JOB_CARD' AND refId = ?"
--   "WHERE type = 'FG_COMPLETED' AND refType = 'PRODUCTION_ORDER' AND refId = ?"
--   "WHERE type = 'RM_ISSUE' AND refType = 'PRODUCTION_ORDER' AND refId = ?"
--   "WHERE refType = 'DELIVERY_ORDER' AND refId = ? AND type = 'FG_DELIVERED'"
-- Hot on every PO-complete + DO-ship cascade; today these fall back to
-- idx_cost_ledger_type (huge type buckets) or idx_cost_ledger_itemId.
CREATE INDEX IF NOT EXISTS idx_cost_ledger_ref
  ON cost_ledger(refType, refId, type);

-- Backs scan-gun FG unit lookup in fg-units.ts:
--   "SELECT * FROM fg_units WHERE unitSerial = ? OR shortCode = ? LIMIT 1"
-- Currently no index on unitSerial — full scan of ~N fg_units per scan.
-- (The shortCode OR-branch still scans but unitSerial is the primary path.)
CREATE INDEX IF NOT EXISTS idx_fg_units_unitSerial
  ON fg_units(unitSerial);

-- Backs wip_items lookup by code — the ONLY way production-orders.ts's wip
-- cascade finds rows:
--   "SELECT id, stockQty FROM wip_items WHERE code = ?"
--   "UPDATE wip_items SET stockQty = 0, status = 'IN_PRODUCTION' WHERE code = ?"
-- Fires on every scan-complete. Table has zero indexes today — full scan.
CREATE INDEX IF NOT EXISTS idx_wip_items_code
  ON wip_items(code);
