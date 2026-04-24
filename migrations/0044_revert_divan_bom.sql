-- Revert 0043. I should not have touched the BOM — the user's BOM is
-- authoritative and their data. Restores every field 0043 halved.

-- Restore BOM templates.
UPDATE bom_templates
SET wipComponents = REPLACE(
  wipComponents,
  '"wipType":"DIVAN","quantity":1',
  '"wipType":"DIVAN","quantity":2'
)
WHERE wipComponents LIKE '%"wipType":"DIVAN","quantity":1%';

-- Restore job_cards wipQty for DIVAN rows that were halved. The previous
-- migration only halved rows where wipQty was exactly po.quantity * 2,
-- so restoration doubles those same rows. Match on wipQty = po.quantity
-- to find the halved set.
UPDATE job_cards
SET wipQty = wipQty * 2
WHERE wipType = 'DIVAN'
  AND wipQty = (
    SELECT po.quantity
    FROM production_orders po
    WHERE po.id = job_cards.productionOrderId
  );

-- Restore wip_items stockQty for DIVAN labels — double them back.
UPDATE wip_items
SET stockQty = stockQty * 2
WHERE stockQty >= 1
  AND code IN (
    SELECT DISTINCT wipLabel
    FROM job_cards
    WHERE wipType = 'DIVAN'
      AND wipLabel IS NOT NULL
  );
