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
INSERT INTO products (
  id, code, name, category, description,
  base_model, size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies, sku_code, fabric_color, pieces, seat_height_prices
)
SELECT
  'prod-5530-stool'                                 AS id,
  '5530-STOOL'                                      AS code,
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5530') AS name,
  category, description,
  '5530'                                            AS base_model,
  size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies,
  REPLACE(COALESCE(sku_code, ''), '5537', '5530')    AS sku_code,
  fabric_color, pieces, seat_height_prices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA' ON CONFLICT DO NOTHING;

INSERT INTO products (
  id, code, name, category, description,
  base_model, size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies, sku_code, fabric_color, pieces, seat_height_prices
)
SELECT
  'prod-5531-stool', '5531-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5531'),
  category, description,
  '5531',
  size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies,
  REPLACE(COALESCE(sku_code, ''), '5537', '5531'),
  fabric_color, pieces, seat_height_prices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA' ON CONFLICT DO NOTHING;

INSERT INTO products (
  id, code, name, category, description,
  base_model, size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies, sku_code, fabric_color, pieces, seat_height_prices
)
SELECT
  'prod-5535-stool', '5535-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5535'),
  category, description,
  '5535',
  size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies,
  REPLACE(COALESCE(sku_code, ''), '5537', '5535'),
  fabric_color, pieces, seat_height_prices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA' ON CONFLICT DO NOTHING;

INSERT INTO products (
  id, code, name, category, description,
  base_model, size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies, sku_code, fabric_color, pieces, seat_height_prices
)
SELECT
  'prod-5536-stool', '5536-STOOL',
  REPLACE(COALESCE(name, '5537 STOOL'), '5537', '5536'),
  category, description,
  '5536',
  size_code, size_label,
  fabric_usage, unit_m3, status,
  cost_price_sen, base_price_sen, price1_sen, production_time_minutes,
  sub_assemblies,
  REPLACE(COALESCE(sku_code, ''), '5537', '5536'),
  fabric_color, pieces, seat_height_prices
FROM products
WHERE code = '5537-STOOL' AND category = 'SOFA' ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 2. product_dept_configs rows — clone 5537-STOOL's production config
--    (unitM3, fabricUsage, price2Sen, per-department category + minutes,
--     subAssemblies, heightsSubAssemblies).
-- ===========================================================================
INSERT INTO product_dept_configs (
  product_code, unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
)
SELECT
  '5530-STOOL', unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
FROM product_dept_configs
WHERE product_code = '5537-STOOL' ON CONFLICT DO NOTHING;

INSERT INTO product_dept_configs (
  product_code, unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
)
SELECT
  '5531-STOOL', unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
FROM product_dept_configs
WHERE product_code = '5537-STOOL' ON CONFLICT DO NOTHING;

INSERT INTO product_dept_configs (
  product_code, unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
)
SELECT
  '5535-STOOL', unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
FROM product_dept_configs
WHERE product_code = '5537-STOOL' ON CONFLICT DO NOTHING;

INSERT INTO product_dept_configs (
  product_code, unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
)
SELECT
  '5536-STOOL', unit_m3, fabric_usage, price2_sen,
  fab_cut_category, fab_cut_minutes,
  fab_sew_category, fab_sew_minutes,
  wood_cut_category, wood_cut_minutes,
  foam_category, foam_minutes,
  framing_category, framing_minutes,
  upholstery_category, upholstery_minutes,
  packing_category, packing_minutes,
  sub_assemblies, heights_sub_assemblies
FROM product_dept_configs
WHERE product_code = '5537-STOOL' ON CONFLICT DO NOTHING;
