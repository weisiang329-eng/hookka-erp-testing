-- ============================================================================
-- Migration 0067 — Service Orders (换货服务).
--
-- BUSINESS MODEL:
--   A Service Order is a customer-reported defect on an already-SHIPPED unit
--   (Sales Order or Consignment Order). It captures the customer claim and
--   the resolution path the factory takes:
--
--     • Mode A — REPRODUCE: open a NEW production order (with
--       service_order_id set) and ship the new unit when it comes off the
--       line. Customer keeps the defective unit until the replacement
--       arrives.
--
--     • Mode B — STOCK_SWAP: pull an existing FG batch from inventory,
--       ship it immediately. Replenishment PO is opened later, manually,
--       through the existing /production flow.
--
--     • Mode C — REPAIR: the defective unit is returned to the factory,
--       repaired by the REPAIR department (cost-tracked, but no new PO),
--       then re-shipped.
--
--   Lifecycle:
--     OPEN → IN_PRODUCTION (A) | RESERVED (B) | IN_REPAIR (C)
--          → READY_TO_SHIP → DELIVERED → CLOSED
--     plus terminal CANCELLED (only allowed from OPEN).
--
--   Cost attribution: all labor / material posted against a Service Order
--   is bucketed under the REPAIR department (dept_isProduction = 0). For
--   Mode A the new production_orders row carries service_order_id so the
--   cost reports can group it as Repair, not Production.
--
-- WHY a new production_orders.service_order_id (vs reusing sales_order_id):
--   The cost/labor reports already group production_orders by their source
--   FK. Service-related production runs are operationally distinct (no
--   customer SO, different cost bucket, sometimes a tiny qty). Treating
--   them as a third source keeps reporting clean and avoids back-pollution
--   of any SO/CO aggregates.
--
-- WHY a separate service_order_returns table (vs flag on fg_batches):
--   The defective unit returning from the customer is NOT inventory in the
--   normal sense — it can't be sold or shipped from until it's been
--   inspected and repaired/scrapped. Putting it in fg_batches with a flag
--   would force every FG-pick query to filter out the flag (easy to miss).
--   A dedicated table keeps the lifecycle (PENDING_DECISION → REPAIRABLE
--   → repaired | SCRAPPED) cleanly isolated.
--
-- NOTE on production_orders mutex:
--   Migration 0064 added consignment_order_id but explicitly states the
--   mutex (exactly-one-of source FK is non-null) is enforced in
--   application code, not as a CHECK constraint. We follow the same
--   convention here — service_order_id joins the family of optional
--   source FKs, app code in /api/routes/service-orders.ts and the
--   shared production-builder treats it the same way.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- service_orders — header.
-- ----------------------------------------------------------------------------
CREATE TABLE service_orders (
  id TEXT PRIMARY KEY,
  -- "SVC-2604-001" style. Unique per organisation across all years.
  service_order_no TEXT NOT NULL,
  -- Source order — exactly one of (SO, CO). source_id refers to the
  -- header table. source_no is a human-readable copy (companySOId /
  -- companyCOId) so the list page doesn't need a join.
  source_type TEXT NOT NULL CHECK (source_type IN ('SO','CO')),
  source_id TEXT NOT NULL,
  source_no TEXT,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  -- Resolution mode chosen at creation. Switching modes requires
  -- cancelling and re-creating the SVC.
  mode TEXT NOT NULL CHECK (mode IN ('REPRODUCE','STOCK_SWAP','REPAIR')),
  status TEXT NOT NULL CHECK (status IN (
    'OPEN','IN_PRODUCTION','RESERVED','IN_REPAIR','READY_TO_SHIP',
    'DELIVERED','CLOSED','CANCELLED'
  )),
  issue_description TEXT,
  -- JSON array of URLs (text). Photo upload not built in v1 — operator
  -- pastes URLs. Stored as TEXT to dodge JSONB-vs-TEXT typing in the
  -- adapter; the API parses on read.
  issue_photos TEXT,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT,
  closed_at TEXT,
  notes TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX idx_service_orders_status ON service_orders(status);
CREATE INDEX idx_service_orders_customer_id ON service_orders(customer_id);
CREATE INDEX idx_service_orders_source ON service_orders(source_type, source_id);
CREATE INDEX idx_service_orders_service_order_no ON service_orders(service_order_no);

-- ----------------------------------------------------------------------------
-- service_order_lines — one row per defective product on the SVC.
-- source_line_id refers back to sales_order_items.id (or
-- consignment_order_items.id) — not FK-enforced because the underlying
-- items table is decided by service_orders.source_type.
-- ----------------------------------------------------------------------------
CREATE TABLE service_order_lines (
  id TEXT PRIMARY KEY,
  service_order_id TEXT NOT NULL,
  source_line_id TEXT,
  product_id TEXT,
  product_code TEXT,
  product_name TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  issue_summary TEXT,
  -- Mode A: which PO was opened to replace this line. Set after the
  -- POST /api/service-orders fan-out succeeds. Nullable until then,
  -- and stays null for Modes B and C.
  resolution_production_order_id TEXT,
  -- Mode B: which FG batch was picked from inventory. Set when the
  -- service order is created in STOCK_SWAP mode.
  resolution_fg_batch_id TEXT,
  FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE CASCADE
);

CREATE INDEX idx_service_order_lines_service_order_id
  ON service_order_lines(service_order_id);
CREATE INDEX idx_service_order_lines_resolution_po
  ON service_order_lines(resolution_production_order_id);
CREATE INDEX idx_service_order_lines_resolution_fg
  ON service_order_lines(resolution_fg_batch_id);

-- ----------------------------------------------------------------------------
-- service_order_returns — defective unit coming back from the customer.
--
-- Lifecycle:
--   PENDING_DECISION → REPAIRABLE  → (repaired_at set) → returned to FG flow
--                    → SCRAPPED   → linked to a stock_adjustments row
--                                   (reason='WRITE_OFF') created via the
--                                   existing Inventory > Adjustments page.
-- ----------------------------------------------------------------------------
CREATE TABLE service_order_returns (
  id TEXT PRIMARY KEY,
  service_order_id TEXT NOT NULL,
  service_order_line_id TEXT,
  product_id TEXT,
  product_code TEXT,
  received_at TEXT NOT NULL,
  received_by TEXT,
  received_by_name TEXT,
  condition TEXT NOT NULL CHECK (condition IN (
    'PENDING_DECISION','REPAIRABLE','SCRAPPED'
  )),
  repair_notes TEXT,
  repaired_at TEXT,
  repaired_by TEXT,
  repaired_by_name TEXT,
  -- When SCRAPPED, this points at the stock_adjustments row that
  -- accounted for the write-off. Set by the user via PUT /:rid; the
  -- adjustment itself is created through the existing Inventory >
  -- Adjustments page (we don't duplicate that flow here).
  scrapped_via_adjustment_id TEXT,
  notes TEXT,
  created_at TEXT,
  FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE CASCADE
);

CREATE INDEX idx_service_order_returns_service_order_id
  ON service_order_returns(service_order_id);
CREATE INDEX idx_service_order_returns_condition
  ON service_order_returns(condition);

-- ----------------------------------------------------------------------------
-- production_orders — add service_order_id as the third optional source FK.
-- A PO must originate from EXACTLY ONE of (SO, CO, SVC). The mutex is
-- enforced in application code (see _shared/production-builder.ts and
-- routes/service-orders.ts) — same convention as 0064 used for CO.
-- ----------------------------------------------------------------------------
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS service_order_id TEXT
  REFERENCES service_orders(id);

-- Cost-bucket discriminator. NULL = normal production (already grouped
-- under the source SO/CO's customer). 'REPAIR' = a service-order-driven
-- run; labor / material costs roll up to the REPAIR department in
-- reporting. Future categories ('R&D','REWORK', ...) can extend the
-- CHECK.
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS cost_category TEXT
  CHECK (cost_category IN ('REPAIR'));

CREATE INDEX idx_production_orders_service_order_id
  ON production_orders(service_order_id);
