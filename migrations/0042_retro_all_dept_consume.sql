-- Retroactive consume across ALL depts. Before today's fix, only Fab Sew
-- IN_PROGRESS triggered upstream-consume. Any completion that skipped
-- IN_PROGRESS (date-cell clicks) left stale wip_items. This migration
-- walks the production chain and zeros every upstream wip_items where a
-- downstream dept has advanced past it.
--
-- Idempotent: zeroing an already-zero row is a no-op.

-- Pass 1: sofa Fab Sew consume (whole SO+fabric group)
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

-- Pass 2: per-wipKey consume for every (dept, upstream-dept) pair. For
-- each JC that has reached COMPLETED/IN_PROGRESS, zero its immediate
-- upstream wip_item.
UPDATE wip_items
SET stockQty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT upstream.wipLabel
  FROM job_cards jc
  JOIN job_cards upstream
    ON upstream.productionOrderId = jc.productionOrderId
   AND upstream.wipKey = jc.wipKey
   AND upstream.sequence < jc.sequence
  WHERE jc.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
    AND jc.departmentCode != 'FAB_CUT'
    AND upstream.wipLabel IS NOT NULL
    AND upstream.sequence = (
      SELECT MAX(u2.sequence)
      FROM job_cards u2
      WHERE u2.productionOrderId = jc.productionOrderId
        AND u2.wipKey = jc.wipKey
        AND u2.sequence < jc.sequence
    )
);
