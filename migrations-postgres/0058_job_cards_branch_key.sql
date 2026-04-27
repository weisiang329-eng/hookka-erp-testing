-- ============================================================================
-- Migration 0058 — job_cards.branchKey column
--
-- BOM-driven sibling grouping for the lock + consume + WIP-display logic.
-- See src/lib/mock-data.ts JobCard.branchKey for the full rationale.
--
-- Within one wipKey ("DIVAN" / "HEADBOARD" / "SOFA_*") the BOM has multiple
-- parallel branches that converge only at UPHOLSTERY:
--   BF Divan:    "Foam" branch (Foam→Frame→(WD)) || "Fabric" branch (Fabric→(FC))
--   BF Headboard: "Webbing" branch (Webbing→Frame→(WD)) || "Foam" branch (Foam→Fabric→(FC))
--   Sofa:        "Foam" branch (...) || "Fabric" branch (...)
--
-- The previous `wipKey + sequence` heuristic flattened these into one chain
-- and produced wrong upstream pointers — most visibly: completing Wood Cut
-- on a BF row caused the inventory display to show Wood Cut taking over Fab
-- Sew's stock (Fab Sew row disappeared) because the linear sequence sort
-- treated FAB_SEW(seq=2) as upstream of WOOD_CUT(seq=3) when in fact they
-- live on different BOM branches.
--
-- branchKey holds the top-level wipComponent's wipCode that this JC
-- descended from (e.g. "Foam", "Fabric", "Webbing"). Joint terminals
-- (UPHOLSTERY, PACKING) live at the BOM root with branchKey = '' so they
-- aren't filtered out by per-branch sibling queries.
--
-- Backfill: best-effort heuristic based on the JC's wipCode + departmentCode
-- (the wipCode-to-branch mapping is fixed per wipType in the seed BOM and
-- in mock-data.ts bfDivanChildren/bfHbChildren). New JCs created after this
-- migration get branchKey stamped at insert time by createJobCardsFromBOM
-- and the jobcard-sync backfill.
-- ============================================================================
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS branch_key TEXT;

CREATE INDEX IF NOT EXISTS idx_job_cards_wip_key_branch_key
  ON job_cards(wip_key, branch_key);

-- Best-effort backfill for already-existing rows. The wipCode → branchKey
-- mapping is stable per BOM (see src/lib/mock-data.ts bfDivanChildren +
-- bfHbChildren). Joint terminals (UPHOLSTERY, PACKING) get '' so they
-- don't get filtered out by per-branch queries.
UPDATE job_cards SET branch_key = ''
  WHERE department_code IN ('UPHOLSTERY','PACKING');

-- BF Divan + Sofa wood branch: WOOD_CUT, FRAMING, WEBBING. Map to "Foam"
-- because in BF Divan the WEBBING JC's wipCode is literally "Foam" (the
-- top-of-subtree node).
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code IN ('WOOD_CUT','FRAMING','WEBBING')
    AND wip_key IN ('DIVAN','SOFA_BASE','SOFA_CUSHION','SOFA_ARMREST','SOFA_HEADREST');

-- BF Headboard wood branch — top-level wipCode is "Webbing".
UPDATE job_cards SET branch_key = 'Webbing'
  WHERE branch_key IS NULL
    AND department_code IN ('WOOD_CUT','FRAMING','WEBBING')
    AND wip_key = 'HEADBOARD';

-- BF Divan + Sofa fab branch: FAB_CUT, FAB_SEW. Top-of-subtree wipCode is
-- "Fabric" in those BOMs.
UPDATE job_cards SET branch_key = 'Fabric'
  WHERE branch_key IS NULL
    AND department_code IN ('FAB_CUT','FAB_SEW')
    AND wip_key IN ('DIVAN','SOFA_BASE','SOFA_CUSHION','SOFA_ARMREST','SOFA_HEADREST');

-- BF Headboard fab branch: FAB_CUT, FAB_SEW, FOAM. Top-of-subtree wipCode
-- is "Foam" (sits in the fab branch in HB BOM, opposite of Divan/Sofa where
-- "Foam" is the wood-branch top).
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code IN ('FAB_CUT','FAB_SEW','FOAM')
    AND wip_key = 'HEADBOARD';

-- Sofa FOAM dept lives in the wood branch (per Sofa BOM, Foam is downstream
-- of Webbing). Map to wood branch.
UPDATE job_cards SET branch_key = 'Foam'
  WHERE branch_key IS NULL
    AND department_code = 'FOAM'
    AND wip_key IN ('SOFA_BASE','SOFA_CUSHION','SOFA_ARMREST','SOFA_HEADREST');

-- Anything still NULL (unknown wipKey, FG legacy, etc.) gets '' so the
-- per-branch filter doesn't accidentally exclude it.
UPDATE job_cards SET branch_key = '' WHERE branch_key IS NULL;
