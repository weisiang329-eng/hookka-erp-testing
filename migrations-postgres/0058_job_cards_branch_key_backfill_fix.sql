-- ============================================================================
-- Migration 0058 backfill fix — wipKey on production data is the templated
-- form 'productCode::idx::wipType::label' (not a literal 'DIVAN' string).
-- The original migration's WHERE clauses did literal matches and missed
-- every row. SQLite has no split_part — use the substring-between-delimiters
-- pattern via instr() to extract segment 3 (the wipType).
--
-- Idempotent: resets branchKey to NULL first, then re-applies. Safe to run
-- multiple times.
-- ============================================================================

UPDATE job_cards SET branch_key = NULL;
UPDATE job_cards SET branch_key = '' WHERE department_code IN ('UPHOLSTERY','PACKING');

-- Helper subquery: extract segment 3 of '::'-separated wipKey.
-- 0058 inline approach: compare wipKey by LIKE patterns for each known wipType.
-- This is uglier than split_part but D1 / SQLite has no split function.

-- BF Divan + Sofa wood branch (top-of-subtree wipCode "Foam").
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code IN ('WOOD_CUT','FRAMING','WEBBING')
    AND (wip_key LIKE '%::DIVAN::%' OR wip_key LIKE '%::SOFA_BASE::%'
         OR wip_key LIKE '%::SOFA_CUSHION::%' OR wip_key LIKE '%::SOFA_ARMREST::%'
         OR wip_key LIKE '%::SOFA_HEADREST::%');

-- BF Headboard wood branch (top-of-subtree wipCode "Webbing").
UPDATE job_cards SET branch_key = 'Webbing'
  WHERE branch_key IS NULL
    AND department_code IN ('WOOD_CUT','FRAMING','WEBBING')
    AND wip_key LIKE '%::HEADBOARD::%';

-- BF Divan + Sofa fab branch (top-of-subtree wipCode "Fabric").
UPDATE job_cards SET branch_key = 'Fabric'
  WHERE branch_key IS NULL
    AND department_code IN ('FAB_CUT','FAB_SEW')
    AND (wip_key LIKE '%::DIVAN::%' OR wip_key LIKE '%::SOFA_BASE::%'
         OR wip_key LIKE '%::SOFA_CUSHION::%' OR wip_key LIKE '%::SOFA_ARMREST::%'
         OR wip_key LIKE '%::SOFA_HEADREST::%');

-- BF Headboard fab branch (top-of-subtree wipCode "Foam" in HB BOM —
-- opposite of Divan/Sofa where "Foam" is the wood-branch top).
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code IN ('FAB_CUT','FAB_SEW','FOAM')
    AND wip_key LIKE '%::HEADBOARD::%';

-- Sofa FOAM dept lives in the wood branch (per Sofa BOM, Foam is downstream
-- of Webbing, top-of-subtree is "Foam").
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code = 'FOAM'
    AND (wip_key LIKE '%::SOFA_BASE::%' OR wip_key LIKE '%::SOFA_CUSHION::%'
         OR wip_key LIKE '%::SOFA_ARMREST::%' OR wip_key LIKE '%::SOFA_HEADREST::%');

UPDATE job_cards SET branch_key = '' WHERE branch_key IS NULL;
