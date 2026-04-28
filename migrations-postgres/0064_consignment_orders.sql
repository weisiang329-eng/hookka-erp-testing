-- ============================================================================
-- Migration 0064 — Consignment Orders (parallel to Sales Orders)
--
-- BUSINESS MODEL:
--   The user's consignment business mirrors the SO flow exactly:
--     CO confirm → Production Order → BOM → WIP → FG → Consignment Note (ship)
--   Consignment Note can either (a) be returned (stock back to main warehouse)
--   or (b) convert directly to Sales Invoice (consignee sold the unit).
--
-- WHY new tables (instead of extending consignment_notes):
--   The legacy `consignment_notes` table (migration 0001 line 1320) holds 11
--   columns and was used as both the "order" and the "note". The user wants
--   these as separate concepts (CO = order with category/divan/leg/fabric/
--   pricing variants; CN = shipment with driver/lorry). This migration adds
--   the proper Order entity. A later migration (PR 3) will repurpose
--   consignment_notes as the shipment entity.
--
-- WHY production_orders.consignmentOrderId (vs separate prod table):
--   Production + inventory are SHARED between SO and CO — same job_cards,
--   same WIP/FG flow, same fg_units. Only the SOURCE of the production
--   request differs. So production_orders gains a second nullable FK; a
--   CHECK constraint enforces exactly-one-source.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- consignment_orders — header. Mirrors sales_orders.
-- ----------------------------------------------------------------------------
CREATE TABLE consignment_orders (
  id TEXT PRIMARY KEY,
  -- Customer's reference numbers (analog of customerPO* on SO)
  customer_co TEXT,
  customer_co_id TEXT,
  customer_co_date TEXT,
  reference TEXT,
  -- Customer
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_state TEXT,
  hub_id TEXT,
  hub_name TEXT,
  -- Hookka's own number — "CO-25001" style. Distinct prefix from SO so
  -- production_orders.poNo (which derives from companyXOId) is unambiguous.
  company_co TEXT,
  company_co_id TEXT,
  company_co_date TEXT,
  -- Dates (same scheduling logic as SO)
  customer_delivery_date TEXT,
  hookka_expected_dd TEXT,
  -- Money
  subtotal_sen INTEGER NOT NULL DEFAULT 0,
  total_sen INTEGER NOT NULL DEFAULT 0,
  -- Status — superset of SO statuses, adds consignment-specific terminal
  -- states (PARTIALLY_SOLD/FULLY_SOLD/RETURNED) carried from the legacy
  -- consignment_notes vocab so existing UI strings still apply.
  status TEXT NOT NULL CHECK (status IN (
    'DRAFT','CONFIRMED','IN_PRODUCTION','READY_TO_SHIP','SHIPPED','DELIVERED',
    'PARTIALLY_SOLD','FULLY_SOLD','RETURNED','CLOSED','ON_HOLD','CANCELLED'
  )),
  overdue TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (hub_id) REFERENCES delivery_hubs(id) ON DELETE SET NULL
);

CREATE INDEX idx_consignment_orders_customer ON consignment_orders(customer_id);
CREATE INDEX idx_consignment_orders_status ON consignment_orders(status);
CREATE INDEX idx_consignment_orders_company_co_id ON consignment_orders(company_co_id);

-- ----------------------------------------------------------------------------
-- consignment_order_items — line items. Mirrors sales_order_items column-
-- for-column so the shared <OrderLineItemEditor> component can drive both
-- without conditional fields. Pricing breakdown (basePrice, divanPrice,
-- legPrice, specialOrderPrice) lives here so the line total is reproducible
-- from stored data without re-running maintenance config lookups.
-- ----------------------------------------------------------------------------
CREATE TABLE consignment_order_items (
  id TEXT PRIMARY KEY,
  consignment_order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  line_suffix TEXT,
  product_id TEXT,
  product_code TEXT,
  product_name TEXT,
  item_category TEXT CHECK (item_category IN ('SOFA','BEDFRAME','ACCESSORY')),
  size_code TEXT,
  size_label TEXT,
  fabric_id TEXT,
  fabric_code TEXT,
  quantity INTEGER NOT NULL,
  gap_inches INTEGER,
  divan_height_inches INTEGER,
  divan_price_sen INTEGER NOT NULL DEFAULT 0,
  leg_height_inches INTEGER,
  leg_price_sen INTEGER NOT NULL DEFAULT 0,
  special_order TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  base_price_sen INTEGER NOT NULL DEFAULT 0,
  unit_price_sen INTEGER NOT NULL DEFAULT 0,
  line_total_sen INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- productId is a runtime-generated variant code — same caveat as
  -- sales_order_items (see migration 0001 line 429). Not FK-enforced.
  FOREIGN KEY (consignment_order_id) REFERENCES consignment_orders(id) ON DELETE CASCADE
);

CREATE INDEX idx_consignment_order_items_order_id ON consignment_order_items(consignment_order_id);

-- ----------------------------------------------------------------------------
-- production_orders — add consignmentOrderId as second optional source FK.
-- A PO must originate from EITHER a SO or a CO (mutex via CHECK). Existing
-- rows all have salesOrderId set, so the new constraint passes for them.
-- ----------------------------------------------------------------------------
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS consignment_order_id TEXT
  REFERENCES consignment_orders(id);

ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS company_co_id TEXT;

CREATE INDEX idx_production_orders_consignment_order_id
  ON production_orders(consignment_order_id);

-- Mutex: exactly one of (salesOrderId, consignmentOrderId) is non-null.
-- Note: SQLite doesn't support adding CHECK constraints via ALTER, so we
-- enforce this in application code (createProductionOrdersForOrder) AND
-- the Postgres migration adds the proper CHECK there. For SQLite (D1
-- legacy path / test env), the application enforcement is the authority.
