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
  id, productionOrderId, departmentId, departmentCode, departmentName,
  sequence, status, dueDate,
  wipKey, wipCode, wipType, wipLabel, wipQty,
  prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name,
  completedDate, estMinutes, actualMinutes, category,
  productionTimeMinutes, overdue, rackingNumber
)
SELECT
  'jc-sfuph-' || lower(hex(randomblob(6))),
  jc.productionOrderId, 'dept-7', 'UPHOLSTERY', 'Upholstery',
  7, 'WAITING', po.targetEndDate,
  jc.wipKey, jc.wipCode, jc.wipType, jc.wipLabel, jc.wipQty,
  0, NULL, NULL, NULL, NULL,
  NULL,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 45
    WHEN 'SOFA_CUSHION'  THEN 15
    WHEN 'SOFA_ARMREST'  THEN 25
    ELSE 30
  END,
  NULL,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 'CAT 4'
    WHEN 'SOFA_CUSHION'  THEN 'CAT 1'
    WHEN 'SOFA_ARMREST'  THEN 'CAT 2'
    ELSE 'CAT 3'
  END,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 45
    WHEN 'SOFA_CUSHION'  THEN 15
    WHEN 'SOFA_ARMREST'  THEN 25
    ELSE 30
  END,
  'PENDING', jc.rackingNumber
FROM job_cards jc
JOIN production_orders po ON po.id = jc.productionOrderId
JOIN (
  SELECT productionOrderId, COALESCE(wipKey, '') AS wk, MIN(id) AS anchor_id
  FROM job_cards
  WHERE departmentCode = 'WEBBING'
  GROUP BY productionOrderId, COALESCE(wipKey, '')
) anchor ON anchor.anchor_id = jc.id
WHERE po.itemCategory = 'SOFA'
  AND NOT EXISTS (
    SELECT 1 FROM job_cards existing
    WHERE existing.productionOrderId = jc.productionOrderId
      AND existing.departmentCode = 'UPHOLSTERY'
      AND COALESCE(existing.wipKey, '') = COALESCE(jc.wipKey, '')
  );

-- Packing job cards — ONE per sofa PO (FG-level). Reads CAT + minutes from
-- bom_templates.l1Processes via json_each so it always reflects the current
-- BOM — whatever the BOM Builder has saved is what lands here.
INSERT INTO job_cards (
  id, productionOrderId, departmentId, departmentCode, departmentName,
  sequence, status, dueDate,
  wipKey, wipCode, wipType, wipLabel, wipQty,
  prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name,
  completedDate, estMinutes, actualMinutes, category,
  productionTimeMinutes, overdue, rackingNumber
)
SELECT
  'jc-sfpkg-' || lower(hex(randomblob(6))),
  po.id, 'dept-8', 'PACKING', 'Packing',
  99, 'WAITING', po.targetEndDate,
  'FG', po.productCode, 'FG', po.productCode, po.quantity,
  0, NULL, NULL, NULL, NULL,
  NULL,
  CAST(COALESCE(json_extract(pkg.value, '$.minutes'), 30) AS INTEGER),
  NULL,
  COALESCE(json_extract(pkg.value, '$.category'), 'CAT 3'),
  CAST(COALESCE(json_extract(pkg.value, '$.minutes'), 30) AS INTEGER),
  'PENDING', NULL
FROM production_orders po
JOIN bom_templates bom
  ON bom.productCode = po.productCode
 AND bom.id = (
   SELECT id FROM bom_templates b2
    WHERE b2.productCode = po.productCode
    ORDER BY
      CASE WHEN b2.versionStatus = 'ACTIVE' THEN 0 ELSE 1 END,
      b2.effectiveFrom DESC
    LIMIT 1
 )
LEFT JOIN json_each(bom.l1Processes) pkg
  ON json_extract(pkg.value, '$.deptCode') = 'PACKING'
WHERE po.itemCategory = 'SOFA'
  AND NOT EXISTS (
    SELECT 1 FROM job_cards existing
    WHERE existing.productionOrderId = po.id
      AND existing.departmentCode = 'PACKING'
  );
