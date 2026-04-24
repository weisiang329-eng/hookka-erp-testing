-- ---------------------------------------------------------------------------
-- 0030_add_stool_variants.sql
-- Purpose: add four new stool product variants that mirror the existing
--   5537-STOOL on every dimension (price, unitM3, fabricUsage, production
--   times, category, seat-height pricing, sub-assemblies, etc.).
--
-- New SKUs:
--   - 5530-STOOL  (baseModel 5530)
--   - 5531-STOOL  (baseModel 5531)
--   - 5535-STOOL  (baseModel 5535)
--   - 5536-STOOL  (baseModel 5536)
--
-- Source of truth: the current row in `products` where code = '5537-STOOL'
-- (and matching `product_dept_configs` where productCode = '5537-STOOL').
--
-- Safety:
--   - INSERT OR IGNORE so re-applying is a silent no-op.
--   - If 5537-STOOL is missing from the live DB, the SELECT returns zero rows
--     and nothing is inserted. In that case run migration 0028 first (which
--     at least corrects 5537-STOOL's price) — or seed 5537-STOOL before this.
--   - Deterministic IDs: prod-<lowercase-code>.
--
-- Dependency: independent of 0028 / 0029. Can land in any order.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. products rows — clone 5537-STOOL's master record into 4 new codes
-- ===========================================================================
INSERT OR IGNORE INTO products (
  id, code, name, category, description,
  baseModel, sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies, skuCode, fabricColor, pieces, seatHeightPrices
)
SELECT
  'prod-5530-stool'                                 AS id,
  '5530-STOOL'                                      AS code,
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5530') AS name,
  category, description,
  '5530'                                            AS baseModel,
  sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies,
  REPLACE(COALESCE(skuCode, ''), '5537', '5530')    AS skuCode,
  fabricColor, pieces, seatHeightPrices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA';

INSERT OR IGNORE INTO products (
  id, code, name, category, description,
  baseModel, sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies, skuCode, fabricColor, pieces, seatHeightPrices
)
SELECT
  'prod-5531-stool', '5531-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5531'),
  category, description,
  '5531',
  sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies,
  REPLACE(COALESCE(skuCode, ''), '5537', '5531'),
  fabricColor, pieces, seatHeightPrices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA';

INSERT OR IGNORE INTO products (
  id, code, name, category, description,
  baseModel, sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies, skuCode, fabricColor, pieces, seatHeightPrices
)
SELECT
  'prod-5535-stool', '5535-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5535'),
  category, description,
  '5535',
  sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies,
  REPLACE(COALESCE(skuCode, ''), '5537', '5535'),
  fabricColor, pieces, seatHeightPrices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA';

INSERT OR IGNORE INTO products (
  id, code, name, category, description,
  baseModel, sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies, skuCode, fabricColor, pieces, seatHeightPrices
)
SELECT
  'prod-5536-stool', '5536-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5536'),
  category, description,
  '5536',
  sizeCode, sizeLabel,
  fabricUsage, unitM3, status,
  costPriceSen, basePriceSen, price1Sen, productionTimeMinutes,
  subAssemblies,
  REPLACE(COALESCE(skuCode, ''), '5537', '5536'),
  fabricColor, pieces, seatHeightPrices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA';

-- ===========================================================================
-- 2. product_dept_configs rows — clone 5537-STOOL's production config
--    (unitM3, fabricUsage, price2Sen, per-department category + minutes,
--     subAssemblies, heightsSubAssemblies).
-- ===========================================================================
INSERT OR IGNORE INTO product_dept_configs (
  productCode, unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
)
SELECT
  '5530-STOOL', unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
FROM product_dept_configs
WHERE productCode = '5537-STOOL';

INSERT OR IGNORE INTO product_dept_configs (
  productCode, unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
)
SELECT
  '5531-STOOL', unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
FROM product_dept_configs
WHERE productCode = '5537-STOOL';

INSERT OR IGNORE INTO product_dept_configs (
  productCode, unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
)
SELECT
  '5535-STOOL', unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
FROM product_dept_configs
WHERE productCode = '5537-STOOL';

INSERT OR IGNORE INTO product_dept_configs (
  productCode, unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
)
SELECT
  '5536-STOOL', unitM3, fabricUsage, price2Sen,
  fabCutCategory, fabCutMinutes,
  fabSewCategory, fabSewMinutes,
  woodCutCategory, woodCutMinutes,
  foamCategory, foamMinutes,
  framingCategory, framingMinutes,
  upholsteryCategory, upholsteryMinutes,
  packingCategory, packingMinutes,
  subAssemblies, heightsSubAssemblies
FROM product_dept_configs
WHERE productCode = '5537-STOOL';
