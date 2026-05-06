-- ============================================================================
-- HOOKKA ERP — Free-text custom special orders on sales_order_items.
--
-- Operator can attach 0..N "Other (custom)" specials to a SO line, each with
-- its own description + surcharge. Lets the shop floor cover edge cases
-- (e.g. "Custom Foam Density 35D", "Special leg ferrules") without bloating
-- the master Specials maintenance config beyond 100 entries.
--
-- Stored as JSON array because the count and shape varies per line:
--   [
--     { "description": "Custom Foam Density 35D", "surchargeSen": 5000 },
--     { "description": "Special ferrules",        "surchargeSen": 2000 }
--   ]
--
-- The aggregate surcharge from this column is folded into the existing
-- specialOrderPriceSen at write time (computed client-side, mirrored on
-- the server). The existing `specialOrder` text column also receives a
-- joined "OTHER: <desc>" suffix so legacy readers (DO print, invoice,
-- detail page) continue to render the full list without code changes.
-- ============================================================================

ALTER TABLE sales_order_items
  ADD COLUMN IF NOT EXISTS customSpecials TEXT;
