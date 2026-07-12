-- Delivery Return module — a return document raised when delivered goods have
-- a problem. One header + N item lines. Links back to the source DO/SO and
-- forward to a Service Order (repair & re-deliver) or a Credit Note (pure
-- return). Deploy does NOT replay migration files — the route self-applies
-- these same CREATE TABLE IF NOT EXISTS at runtime; this file is the record.
CREATE TABLE IF NOT EXISTS delivery_returns (
  id                TEXT PRIMARY KEY,
  return_no         TEXT NOT NULL,
  delivery_order_id TEXT,
  do_no             TEXT,
  sales_order_id    TEXT,
  company_so_id     TEXT,
  customer_id       TEXT,
  customer_name     TEXT,
  customer_po_id    TEXT,
  -- Decided when the operator processes the return.
  return_type       TEXT,  -- 'PURE_RETURN' | 'REPAIR_REDELIVER' | NULL (undecided)
  status            TEXT NOT NULL DEFAULT 'OPEN',
  -- OPEN → RETURNED_TO_STOCK → (SERVICE_SPAWNED | CN_ISSUED) → REDELIVERED → CLOSED | CANCELLED
  service_case_id   TEXT,
  service_order_id  TEXT,   -- the SV sales_orders row (production-backed replacement)
  credit_note_id    TEXT,
  reason            TEXT,
  notes             TEXT,
  returned_at       TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  org_id            TEXT
);

CREATE TABLE IF NOT EXISTS delivery_return_items (
  id                  TEXT PRIMARY KEY,
  delivery_return_id  TEXT NOT NULL,
  production_order_id TEXT,
  po_no               TEXT,
  product_code        TEXT,
  product_name        TEXT,
  wip_label           TEXT,
  quantity            DOUBLE PRECISION NOT NULL DEFAULT 1,
  problem             TEXT,
  disposition         TEXT,   -- 'RETURN_TO_STOCK' | 'SCRAP'
  fg_unit_id          TEXT,
  was_invoiced        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (delivery_return_id) REFERENCES delivery_returns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_returns_do ON delivery_returns(delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_returns_so ON delivery_returns(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_return_items_dr ON delivery_return_items(delivery_return_id);
