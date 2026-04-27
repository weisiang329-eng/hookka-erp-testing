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
UPDATE bom_templates SET wipComponents = REPLACE(wipComponents, 'Faom', 'Foam') WHERE wipComponents LIKE '%Faom%';
UPDATE job_cards SET wipCode = REPLACE(wipCode, 'Faom', 'Foam') WHERE wipCode LIKE '%Faom%';
UPDATE job_cards SET wipLabel = REPLACE(wipLabel, 'Faom', 'Foam') WHERE wipLabel LIKE '%Faom%';
UPDATE job_cards SET branchKey = REPLACE(branchKey, 'Faom', 'Foam') WHERE branchKey LIKE '%Faom%';
UPDATE wip_items SET code = REPLACE(code, 'Faom', 'Foam') WHERE code LIKE '%Faom%';
