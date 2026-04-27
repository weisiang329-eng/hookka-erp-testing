-- ============================================================================
-- Migration 0059 — fix "Faom" → "Foam" typo across BOM + JC + wip_items
--
-- The Sofa Base BOM had a long-standing typo "(Faom)" instead of "(Foam)".
-- Once the BOM-walked branchKey landed (migration 0058 + commit 19b2fcc) the
-- typo became visible — branchKeys for Sofa Base wood subtree read
-- "(Faom)" while every other Sofa wood branch read "(Foam)". Functionally
-- harmless (different branchKeys still group correctly within each PO) but
-- ugly and confusing for operators reading the WIP / branchKey columns.
-- Global s/Faom/Foam/ across all four affected columns.
--
-- Idempotent — REPLACE() on rows that no longer contain "Faom" is a no-op.
-- ============================================================================
UPDATE bom_templates SET wip_components = REPLACE(wip_components, 'Faom', 'Foam') WHERE wip_components LIKE '%Faom%';
UPDATE job_cards SET wip_code = REPLACE(wip_code, 'Faom', 'Foam') WHERE wip_code LIKE '%Faom%';
UPDATE job_cards SET wip_label = REPLACE(wip_label, 'Faom', 'Foam') WHERE wip_label LIKE '%Faom%';
UPDATE job_cards SET branch_key = REPLACE(branch_key, 'Faom', 'Foam') WHERE branch_key LIKE '%Faom%';
UPDATE wip_items SET code = REPLACE(code, 'Faom', 'Foam') WHERE code LIKE '%Faom%';
