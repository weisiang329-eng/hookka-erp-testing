-- ============================================================================
-- HOOKKA ERP — Project Order flag on sales_orders.
--
-- When isProjectOrder = 1 (true), SOFA items on the SO are treated like
-- BEDFRAME items by the production cascade:
--   - quantity N → N production_orders (line-suffixed -01..-NN), each qty=1
--   - FAB_CUT cross-PO merge is disabled — each PO gets its own FC JC
--   - All other depts (FAB_SEW / WOOD_CUT / FRAMING / WEBBING / FOAM /
--     UPHOLSTERY / PACKING) also become per-PO instead of per-set
--
-- Default = 0 (false) preserves the legacy behavior: SOFA × N stays as one
-- production_order with quantity=N (single set tracked together).
--
-- Pricing / BOM expansion / inventory consumption logic is NOT affected —
-- the flag only controls how the cascade fans the line into PO rows.
-- ============================================================================

ALTER TABLE sales_orders
  ADD COLUMN isProjectOrder INTEGER NOT NULL DEFAULT 0;
