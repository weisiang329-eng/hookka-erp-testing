-- BOM templates had DIVAN quantity=2 baked in (1 bedframe = 2 divans)
-- but physically each BF has exactly 1 divan panel. Replace every
-- `"wipType":"DIVAN","quantity":2` → `"wipType":"DIVAN","quantity":1`
-- inside bom_templates.wipComponents JSON, and retroactively update
-- every DIVAN job_cards row that inherited the doubled wipQty.

UPDATE bom_templates
SET wipComponents = REPLACE(
  wipComponents,
  '"wipType":"DIVAN","quantity":2',
  '"wipType":"DIVAN","quantity":1'
)
WHERE wipComponents LIKE '%"wipType":"DIVAN","quantity":2%';

-- Existing job_cards still carry the doubled qty. Halve the ones where
-- po.quantity × 2 still equals the current wipQty so we don't disturb
-- legacy qty>1 POs that happen to multiply to the same value.
UPDATE job_cards
SET wipQty = (wipQty / 2)
WHERE wipType = 'DIVAN'
  AND wipQty >= 2
  AND wipQty IN (
    SELECT (po.quantity * 2)
    FROM production_orders po
    WHERE po.id = job_cards.productionOrderId
  );

-- Retroactively halve any existing wip_items stockQty that was written
-- from those doubled JCs. Safe because we ONLY halve even numbers and
-- only codes that match a DIVAN wipLabel.
UPDATE wip_items
SET stockQty = (stockQty / 2)
WHERE stockQty >= 2
  AND stockQty % 2 = 0
  AND code IN (
    SELECT DISTINCT wipLabel
    FROM job_cards
    WHERE wipType = 'DIVAN'
      AND wipLabel IS NOT NULL
  );
