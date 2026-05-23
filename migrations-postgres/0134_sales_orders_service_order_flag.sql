-- ---------------------------------------------------------------------------
-- 0134_sales_orders_service_order_flag.sql — per-SO flag to mark this SO as
-- an aftersales Service Order rather than a normal Sales Order.
--
-- Wei Siang 2026-05-23: a Service Order is the new aftersales artifact that
-- spawns from a Service Case (Phase 2) or from a copy of an existing SO/CO
-- (Phase 1 — manual). It reuses the entire sales_orders → production_orders
-- → delivery_orders → invoices cascade unchanged — the cascade is already
-- battle-tested with 0-amount lines (warranty repairs, free swaps), so we
-- get the whole pipeline for free.
--
-- The only thing the cascade needs to know is "this is a Service Order"
-- so the API can:
--   * pick a different companySOId prefix — `SV-YYMM-NNN` instead of
--     `SO-YYMM-NNN` (the existing service_orders module uses `SVC-` for
--     its own service-order-number sequence; we deliberately pick `SV-`
--     to avoid the collision).
--   * scope the Sales Orders list to NORMAL orders by default
--     (?isServiceOrder=false) so the new Service Orders never bleed into
--     the regular SO grid.
--   * exclude these from revenue reports (later — flag is wired now so the
--     reports module can consult it without another migration).
--
-- Default FALSE so every existing SO stays a normal Sales Order.
-- ---------------------------------------------------------------------------

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS is_service_order BOOLEAN NOT NULL DEFAULT FALSE;
