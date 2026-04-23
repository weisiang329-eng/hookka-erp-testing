-- Migration 0027: Backfill missing UPHOLSTERY + PACKING job cards for existing sofa POs.
--
-- Context
-- --------
-- Sofa production orders in D1 never got UPH or PACKING job cards because:
--   1) The original mock-data BOM templates had no UPH/PKG entries for sofa WIPs.
--   2) createProductionOrdersForSO only walked wipComponents, not l1Processes —
--      so even after the BOM got a FG-level `Packing CAT 1 40m` via the BOM
--      Builder UI, the PO confirm flow still skipped it.
-- Both code paths are now fixed (mock-data.ts + sales-orders.ts) but existing
-- sofa POs are orphaned. This migration repairs them.
--
-- Model
-- -----
-- Sofa assembles at Upholstery (Base/Cushion/Arm become one finished sofa),
-- then goes to Packing as a single unit. So:
--   UPHOLSTERY  → one job card PER WIP (Base, Cushion, Arm)  → 3 UPH stickers
--   PACKING     → ONE job card per sofa PO (FG level)         → 1 PKG sticker
-- Bedframes are unchanged (Packing is per-WIP because Divan + HB ship separately).
--
-- Upholstery job cards — one per (sofa PO, WIP), WIP metadata cloned from the
-- WEBBING card that already exists for each WIP.
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

-- Packing job cards — ONE per sofa PO (FG-level). Read CAT + minutes straight
-- out of bom_templates.l1Processes via SQLite json_each so we don't hardcode
-- defaults — whatever the BOM Builder says is what lands. wipKey = 'FG' and
-- wipLabel = productCode match what createProductionOrdersForSO now emits.
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
