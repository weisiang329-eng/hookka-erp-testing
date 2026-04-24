-- One-shot retroactive consume: zero FAB_CUT wip_items for sofa sets
-- whose FAB_SEW has already started. Previously applyWipInventoryChange
-- only zeroed on IN_PROGRESS, but date-cell clicks skipped IN_PROGRESS,
-- leaving stale FAB_CUT stock.

UPDATE wip_items
SET stockQty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT fc.wipLabel
  FROM job_cards fc
  JOIN production_orders po ON po.id = fc.productionOrderId
  WHERE fc.departmentCode = 'FAB_CUT'
    AND fc.wipLabel IS NOT NULL
    AND po.itemCategory = 'SOFA'
    AND EXISTS (
      SELECT 1
      FROM job_cards fs
      JOIN production_orders po2 ON po2.id = fs.productionOrderId
      WHERE fs.departmentCode = 'FAB_SEW'
        AND fs.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
        AND po2.salesOrderId = po.salesOrderId
        AND po2.fabricCode = po.fabricCode
        AND po2.itemCategory = 'SOFA'
    )
);

-- BF / accessory retro consume: zero FAB_CUT wip_items whose wipKey's
-- FAB_SEW JC is already active.
UPDATE wip_items
SET stockQty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT fc.wipLabel
  FROM job_cards fc
  JOIN production_orders po ON po.id = fc.productionOrderId
  WHERE fc.departmentCode = 'FAB_CUT'
    AND fc.wipLabel IS NOT NULL
    AND po.itemCategory != 'SOFA'
    AND EXISTS (
      SELECT 1
      FROM job_cards fs
      WHERE fs.productionOrderId = fc.productionOrderId
        AND fs.wipKey = fc.wipKey
        AND fs.departmentCode = 'FAB_SEW'
        AND fs.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
    )
);
