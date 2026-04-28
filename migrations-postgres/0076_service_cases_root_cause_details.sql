-- ============================================================================
-- Migration 0076 — Service Cases: root cause details + 2 new categories
--
-- Per design 2026-04-28: each root-cause category gets a second-level
-- structured detail. Stored as JSON on service_cases.root_cause_details so
-- each category can carry its own fields without bloating the schema with
-- per-category columns.
--
-- Shape per category (frontend types are authoritative; this is for ops
-- reference):
--   PRODUCTION  { departmentCode, departmentName, where, workerName }
--   DESIGN      { productId, productCode, productName, component, suggestedFix }
--   MATERIAL    { rawMaterialId, rawMaterialCode, itemGroup, supplierId, supplierName, grnRef }
--   PROCESS     { departmentCode, departmentName, sopName, gapType }
--   CUSTOMER    { subReason }
--   TRANSPORT   { threePlCompany, damageType, doNo, driverName }
--   SALES       { salesPerson, errorType }                          -- NEW
--   PICKING     { departmentCode, missingItem }                     -- NEW
--   OTHER       { }
--
-- Two new top-level categories were factored out of the original 7 because
-- operators kept tagging "process gaps" or "production errors" when the
-- real cause was an order-taking mistake (Sales) or a packing-line miss
-- (Picking) — different owners, different fixes.
-- ============================================================================

-- 1. Drop the old CHECK constraint (Postgres named it; find by column).
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT con.conname
    INTO c_name
    FROM pg_constraint con
    JOIN pg_attribute   att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'service_cases'::regclass
     AND con.contype = 'c'
     AND att.attname = 'root_cause_category'
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE service_cases DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END $$;

-- 2. Re-add CHECK with the two new categories.
ALTER TABLE service_cases
  ADD CONSTRAINT service_cases_root_cause_category_check
  CHECK (root_cause_category IN (
    'PRODUCTION','DESIGN','MATERIAL','PROCESS','CUSTOMER','TRANSPORT',
    'SALES','PICKING','OTHER'
  ));

-- 3. Details JSON column.
ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS root_cause_details TEXT;
