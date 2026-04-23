-- Migration 0027: Backfill missing UPHOLSTERY + PACKING job cards for existing sofa POs.
--
-- Context: the sofa BOM templates (SF_BASE / SF_CUSHION / SF_ARM in
-- src/lib/mock-data.ts) originally had no UPHOLSTERY or PACKING processes,
-- so every sofa production order seeded into D1 was missing job cards for
-- those two departments. Commit 25b5446 added the processes to the code
-- templates, but that only affects newly-confirmed SOs. This migration
-- repairs the existing data so sofa POs show up in the Packing production
-- sheet, in the planning overview's PACKING/UPHOLSTERY columns, and in the
-- dept sticker batch print.
--
-- For each sofa PO, pick one WEBBING job card per WIP (via GROUP BY so we
-- don't double-insert if a WIP somehow has multiple WEBBING cards), copy
-- its wipKey/wipCode/wipType/wipLabel/wipQty, and insert a matching
-- UPHOLSTERY and PACKING card. Minutes/category mirror the values used by
-- the fixed mock-data templates, keyed off wipType so Base/Cushion/Arm
-- each get their own tier.

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
  jc.productionOrderId, 'dept-8', 'PACKING', 'Packing',
  8, 'WAITING', po.targetEndDate,
  jc.wipKey, jc.wipCode, jc.wipType, jc.wipLabel, jc.wipQty,
  0, NULL, NULL, NULL, NULL,
  NULL,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 25
    WHEN 'SOFA_CUSHION'  THEN 10
    WHEN 'SOFA_ARMREST'  THEN 15
    ELSE 20
  END,
  NULL,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 'CAT 3'
    WHEN 'SOFA_CUSHION'  THEN 'CAT 1'
    WHEN 'SOFA_ARMREST'  THEN 'CAT 2'
    ELSE 'CAT 3'
  END,
  CASE jc.wipType
    WHEN 'SOFA_BASE'     THEN 25
    WHEN 'SOFA_CUSHION'  THEN 10
    WHEN 'SOFA_ARMREST'  THEN 15
    ELSE 20
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
      AND existing.departmentCode = 'PACKING'
      AND COALESCE(existing.wipKey, '') = COALESCE(jc.wipKey, '')
  );
