-- 0181: add material_code column to purchase_order_items
-- Previously the RM code was mashed into materialName as "CODE - DESCRIPTION".
-- New POs now store the code separately; old rows fall back via splitCodeName.
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS material_code TEXT;
