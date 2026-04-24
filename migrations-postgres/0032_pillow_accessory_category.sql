-- Migration 0032: reclassify pillow SKUs from SOFA to ACCESSORY.
--
-- Why
-- ---
-- LONG PILLOW and SQUARE PILLOW were originally seeded under category=SOFA
-- because they ship alongside sofas, but they don't follow the sofa WIP
-- chain (no FOAM / WOOD_CUT / FRAMING / WEBBING / UPHOLSTERY). Their BOM
-- has an empty l1Processes and only FAB_CUT + FAB_SEW + PACKING JCs, which
-- is exactly what the ACCESSORY category exists for.
--
-- The reclassification ripples to three tables because itemCategory is
-- mirrored on every row that ever references the product — the CHECK
-- constraint already allows ACCESSORY on all three, no schema changes.
--
-- Effect
-- ------
--   - Products page gains an ACCESSORY tab (auto-derived from category set).
--   - Sales create no longer prompts for sofa seat height / bedframe
--     dimensions on pillow line items — category switches the form layout
--     to the accessory-minimal path (SKU + fabric + qty).
--   - Planning sheets, audits, and any category-based filters stop
--     treating pillows as sofas.
--
-- Idempotent: all three UPDATEs are narrow WHERE-based rewrites. Running
-- again is a no-op once category is ACCESSORY.

UPDATE products
   SET category = 'ACCESSORY'
 WHERE code IN ('LONG PILLOW', 'SQUARE PILLOW')
   AND category = 'SOFA';

UPDATE sales_order_items
   SET item_category = 'ACCESSORY'
 WHERE product_code IN ('LONG PILLOW', 'SQUARE PILLOW')
   AND item_category = 'SOFA';

UPDATE production_orders
   SET item_category = 'ACCESSORY'
 WHERE product_code IN ('LONG PILLOW', 'SQUARE PILLOW')
   AND item_category = 'SOFA';
