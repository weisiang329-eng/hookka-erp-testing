-- Revert 0043. I should not have touched the BOM — the user's BOM is
-- authoritative and their data. Restores every field 0043 halved.

-- Restore BOM templates.
UPDATE bom_templates
SET wip_components = REPLACE(
  wip_components,
  '"wipType":"DIVAN","quantity":1',
  '"wipType":"DIVAN","quantity":2'
)
WHERE wip_components LIKE '%"wipType":"DIVAN","quantity":1%';

-- Restore job_cards wipQty for DIVAN rows that were halved. The previous
-- migration only halved rows where wipQty was exactly po.quantity * 2,
-- so restoration doubles those same rows. Match on wipQty = po.quantity
-- to find the halved set.
UPDATE job_cards
SET wip_qty = wip_qty * 2
WHERE wip_type = 'DIVAN'
  AND wip_qty = (
    SELECT po.quantity
    FROM production_orders po
    WHERE po.id = job_cards.production_order_id
  );

-- Restore wip_items stockQty for DIVAN labels — double them back.
UPDATE wip_items
SET stock_qty = stock_qty * 2
WHERE stock_qty >= 1
  AND code IN (
    SELECT DISTINCT wip_label
    FROM job_cards
    WHERE wip_type = 'DIVAN'
      AND wip_label IS NOT NULL
  );
