-- One-shot retroactive consume: zero FAB_CUT wip_items for sofa sets
-- whose FAB_SEW has already started. Previously applyWipInventoryChange
-- only zeroed on IN_PROGRESS, but date-cell clicks skipped IN_PROGRESS,
-- leaving stale FAB_CUT stock.

UPDATE wip_items
SET stock_qty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT fc.wip_label
  FROM job_cards fc
  JOIN production_orders po ON po.id = fc.production_order_id
  WHERE fc.department_code = 'FAB_CUT'
    AND fc.wip_label IS NOT NULL
    AND po.item_category = 'SOFA'
    AND EXISTS (
      SELECT 1
      FROM job_cards fs
      JOIN production_orders po2 ON po2.id = fs.production_order_id
      WHERE fs.department_code = 'FAB_SEW'
        AND fs.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
        AND po2.sales_order_id = po.sales_order_id
        AND po2.fabric_code = po.fabric_code
        AND po2.item_category = 'SOFA'
    )
);

-- BF / accessory retro consume: zero FAB_CUT wip_items whose wipKey's
-- FAB_SEW JC is already active.
UPDATE wip_items
SET stock_qty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT fc.wip_label
  FROM job_cards fc
  JOIN production_orders po ON po.id = fc.production_order_id
  WHERE fc.department_code = 'FAB_CUT'
    AND fc.wip_label IS NOT NULL
    AND po.item_category != 'SOFA'
    AND EXISTS (
      SELECT 1
      FROM job_cards fs
      WHERE fs.production_order_id = fc.production_order_id
        AND fs.wip_key = fc.wip_key
        AND fs.department_code = 'FAB_SEW'
        AND fs.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
    )
);
