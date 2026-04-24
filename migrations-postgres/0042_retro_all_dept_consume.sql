-- Retroactive consume across ALL depts. Before today's fix, only Fab Sew
-- IN_PROGRESS triggered upstream-consume. Any completion that skipped
-- IN_PROGRESS (date-cell clicks) left stale wip_items. This migration
-- walks the production chain and zeros every upstream wip_items where a
-- downstream dept has advanced past it.
--
-- Idempotent: zeroing an already-zero row is a no-op.

-- Pass 1: sofa Fab Sew consume (whole SO+fabric group)
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

-- Pass 2: per-wipKey consume for every (dept, upstream-dept) pair. For
-- each JC that has reached COMPLETED/IN_PROGRESS, zero its immediate
-- upstream wip_item.
UPDATE wip_items
SET stock_qty = 0, status = 'IN_PRODUCTION'
WHERE code IN (
  SELECT DISTINCT upstream.wip_label
  FROM job_cards jc
  JOIN job_cards upstream
    ON upstream.production_order_id = jc.production_order_id
   AND upstream.wip_key = jc.wip_key
   AND upstream.sequence < jc.sequence
  WHERE jc.status IN ('COMPLETED','TRANSFERRED','IN_PROGRESS')
    AND jc.department_code != 'FAB_CUT'
    AND upstream.wip_label IS NOT NULL
    AND upstream.sequence = (
      SELECT MAX(u2.sequence)
      FROM job_cards u2
      WHERE u2.production_order_id = jc.production_order_id
        AND u2.wip_key = jc.wip_key
        AND u2.sequence < jc.sequence
    )
);
