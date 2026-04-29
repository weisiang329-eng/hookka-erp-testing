-- ============================================================================
-- Migration 0089 — R&D Projects: clone-from-competitor source fields
--
-- Per design 2026-04-29: small-shop reality is that a lot of R&D work starts
-- with the boss buying a competitor's sofa and reverse-engineering it. This
-- is a real, distinct workflow — different from "DEVELOPMENT" (clean-sheet
-- design) and "IMPROVEMENT" (fix a known case). We give it its own
-- project_type so reports can later answer "how much R&D effort goes into
-- replication vs. original work?".
--
-- Adds 'CLONE' to the project_type CHECK and four optional source fields
-- that capture what we bought: model name, brand/supplier, purchase
-- reference (for accounting trace), and free-form notes (dimensions,
-- specs, why we picked it). All four fields are nullable — they only
-- make sense for projectType = 'CLONE' but we don't enforce that at the
-- DB layer (UI gates input; existing rows stay untouched).
-- ============================================================================

-- 1. Allow project_type = 'CLONE' --------------------------------------------
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT con.conname
    INTO c_name
    FROM pg_constraint con
    JOIN pg_attribute   att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'rd_projects'::regclass
     AND con.contype = 'c'
     AND att.attname = 'project_type'
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE rd_projects DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END $$;

ALTER TABLE rd_projects
  ADD CONSTRAINT rd_projects_project_type_check
  CHECK (project_type IN ('DEVELOPMENT','IMPROVEMENT','CLONE'));

-- 2. Source product fields (only meaningful for CLONE) -----------------------
ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS source_product_name TEXT;
ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS source_brand        TEXT;
ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS source_purchase_ref TEXT;
ALTER TABLE rd_projects ADD COLUMN IF NOT EXISTS source_notes        TEXT;
