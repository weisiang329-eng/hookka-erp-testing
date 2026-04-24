-- ---------------------------------------------------------------------------
-- 0034_revert_stool_variants.sql
-- Purpose: reverse 0033_add_stool_variants.sql — user decided to add the
--   5530/5531/5535/5536 stool variants manually via the Products UI rather
--   than have them seeded from 5537-STOOL, so the cloned rows are being
--   removed before any sales orders reference them.
--
-- Removes:
--   - products rows with code IN ('5530-STOOL','5531-STOOL','5535-STOOL','5536-STOOL')
--   - product_dept_configs rows keyed on the same productCodes
--
-- Safe guards:
--   - WHERE code IN (...) narrows to exactly the four cloned variants; the
--     original 5537-STOOL (seeded elsewhere) is untouched.
--   - If any sales_order_items or production_orders have already been
--     created against these codes (unlikely — the variants only existed for
--     ~minutes), SQLite will NOT cascade-delete them thanks to no ON DELETE
--     CASCADE on those FKs, and the DELETE will error. Confirm no live use
--     before this lands, or relax with IF NOT EXISTS-style checks.
--
-- Idempotent: re-running after the rows are gone is a silent no-op.
-- ---------------------------------------------------------------------------

DELETE FROM product_dept_configs
 WHERE productCode IN (
   '5530-STOOL', '5531-STOOL', '5535-STOOL', '5536-STOOL'
 );

DELETE FROM products
 WHERE code IN (
   '5530-STOOL', '5531-STOOL', '5535-STOOL', '5536-STOOL'
 )
   AND category = 'SOFA';
