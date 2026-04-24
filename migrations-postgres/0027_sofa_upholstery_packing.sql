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

-- Packing job cards — ONE per sofa PO (FG-level). Read CAT + minutes straight
-- out of bom_templates.l1Processes via SQLite json_each so we don't hardcode
-- defaults — whatever the BOM Builder says is what lands. wipKey = 'FG' and
-- wipLabel = productCode match what createProductionOrdersForSO now emits.
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
