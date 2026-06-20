-- 0103: add material_code column to purchase_order_items (SQLite)
-- Previously the RM code was mashed into materialName as "CODE - DESCRIPTION".
-- New POs now store the code separately; old rows fall back via splitCodeName.
ALTER TABLE purchase_order_items ADD COLUMN material_code TEXT;
