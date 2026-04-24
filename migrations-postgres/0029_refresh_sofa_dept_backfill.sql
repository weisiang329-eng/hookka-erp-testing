-- Migration 0029: Re-run the sofa UPHOLSTERY + PACKING backfill.
--
-- Context
-- --------
-- Migration 0027 added the UPHOLSTERY + PACKING INSERT statements for
-- existing sofa POs, but at the time it ran (2026-04-23 14:27) most sofa
-- BOM templates didn't yet have a `l1Processes` entry with deptCode=PACKING
-- — so the inner JOIN on bom_templates matched nothing for ~180 sofa POs
-- and the INSERT silently did nothing. Only 4 sofa POs ended up with a
-- Packing job card (those came in via the live createProductionOrdersForSO
-- path, not the migration).
--
-- BOM templates are now complete, so re-running the same idempotent
-- INSERTs picks up the previously-skipped POs without disturbing the 4
-- that already have cards (NOT EXISTS guards make this safe to re-run).
--
-- No schema changes. Pure data repair.
--
-- Upholstery job cards — one per (sofa PO, WIP), cloned from WEBBING anchor.
INSERT INTO job_cards (
  id, production_order_id, department_id, department_code, department_name,
  sequence, status, due_date,
  wip_key, wip_code, wip_type, wip_label, wip_qty,
  prerequisite_met, pic1_id, pic1_name, pic2_id, pic2_name,
  completed_date, est_minutes, actual_minutes, category,
  production_time_minutes, overdue, racking_number
)
SELECT
  'jc-sfuph-' || lower(hex(randomblob(6))),
  jc.production_order_id, 'dept-7', 'UPHOLSTERY', 'Upholstery',
  7, 'WAITING', po.target_end_date,
  jc.wip_key, jc.wip_code, jc.wip_type, jc.wip_label, jc.wip_qty,
  0, NULL, NULL, NULL, NULL,
  NULL,
  CASE jc.wip_type
    WHEN 'SOFA_BASE'     THEN 45
    WHEN 'SOFA_CUSHION'  THEN 15
    WHEN 'SOFA_ARMREST'  THEN 25
    ELSE 30
  END,
  NULL,
  CASE jc.wip_type
    WHEN 'SOFA_BASE'     THEN 'CAT 4'
    WHEN 'SOFA_CUSHION'  THEN 'CAT 1'
    WHEN 'SOFA_ARMREST'  THEN 'CAT 2'
    ELSE 'CAT 3'
  END,
  CASE jc.wip_type
    WHEN 'SOFA_BASE'     THEN 45
    WHEN 'SOFA_CUSHION'  THEN 15
    WHEN 'SOFA_ARMREST'  THEN 25
    ELSE 30
  END,
  'PENDING', jc.racking_number
FROM job_cards jc
JOIN production_orders po ON po.id = jc.production_order_id
JOIN (
  SELECT production_order_id, COALESCE(wip_key, '') AS wk, MIN(id) AS anchor_id
  FROM job_cards
  WHERE department_code = 'WEBBING'
  GROUP BY production_order_id, COALESCE(wip_key, '')
) anchor ON anchor.anchor_id = jc.id
WHERE po.item_category = 'SOFA'
  AND NOT EXISTS (
    SELECT 1 FROM job_cards existing
    WHERE existing.production_order_id = jc.production_order_id
      AND existing.department_code = 'UPHOLSTERY'
      AND COALESCE(existing.wip_key, '') = COALESCE(jc.wip_key, '')
  );

-- Packing job cards — ONE per sofa PO (FG-level). Reads CAT + minutes from
-- bom_templates.l1Processes via json_each so it always reflects the current
-- BOM — whatever the BOM Builder has saved is what lands here.
INSERT INTO job_cards (
  id, production_order_id, department_id, department_code, department_name,
  sequence, status, due_date,
  wip_key, wip_code, wip_type, wip_label, wip_qty,
  prerequisite_met, pic1_id, pic1_name, pic2_id, pic2_name,
  completed_date, est_minutes, actual_minutes, category,
  production_time_minutes, overdue, racking_number
)
SELECT
  'jc-sfpkg-' || lower(hex(randomblob(6))),
  po.id, 'dept-8', 'PACKING', 'Packing',
  99, 'WAITING', po.target_end_date,
  'FG', po.product_code, 'FG', po.product_code, po.quantity,
  0, NULL, NULL, NULL, NULL,
  NULL,
  CAST(COALESCE(json_extract(pkg.value, '$.minutes'), 30) AS INTEGER),
  NULL,
  COALESCE(json_extract(pkg.value, '$.category'), 'CAT 3'),
  CAST(COALESCE(json_extract(pkg.value, '$.minutes'), 30) AS INTEGER),
  'PENDING', NULL
FROM production_orders po
JOIN bom_templates bom
  ON bom.product_code = po.product_code
 AND bom.id = (
   SELECT id FROM bom_templates b2
    WHERE b2.product_code = po.product_code
    ORDER BY
      CASE WHEN b2.version_status = 'ACTIVE' THEN 0 ELSE 1 END,
      b2.effective_from DESC
    LIMIT 1
 )
LEFT JOIN json_each(bom.l1_processes) pkg
  ON json_extract(pkg.value, '$.deptCode') = 'PACKING'
WHERE po.item_category = 'SOFA'
  AND NOT EXISTS (
    SELECT 1 FROM job_cards existing
    WHERE existing.production_order_id = po.id
      AND existing.department_code = 'PACKING'
  );
