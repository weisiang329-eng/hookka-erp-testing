-- ============================================================================
-- 0179 — Per-line discount (discount_sen) on price-bearing document items.
--
-- Adds `discount_sen INTEGER NOT NULL DEFAULT 0` to the four line-item tables
-- that carry customer-facing prices. Default 0 means every existing row is
-- discount-free — no data migration required.
--
-- Stage 1 wires Sales Order only; the column is added to all four tables now
-- (cheap ALTER; other tables wired in stages 2–4).
--
-- snake_case enforced: the d1-compat shim maps camelCase→snake_case via
-- column-rename-map.json; adding `discountSen`→`discount_sen` there lets the
-- backend INSERT/UPDATE use the camelCase name safely.
-- ============================================================================

ALTER TABLE sales_order_items      ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consignment_order_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items           ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0;

-- quotation_items does not exist in this codebase — skip.
