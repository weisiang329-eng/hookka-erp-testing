-- ============================================================================
-- 0166 — Responsible Unit on Service Cases.
--
-- service_cases.responsibleunit:
--   Which business unit caused the issue (owner-level attribution, set from
--   the case detail's Root Cause & Prevention card). One of PRODUCTION / QC /
--   R_AND_D / OFFICE / TRANSPORT; NULL = not set. Validated in
--   src/api/routes/service-cases.ts PUT /:id (the frontend select offers the
--   same 5 values, empty option clears to NULL).
--
-- ⚠ ADAPTER RULE: also self-applied at runtime (service-cases.ts
-- ensureCaseLinkColumns) with the lowercase name, so a tool apply is a no-op
-- on databases where the runtime already created it. Reads are dual-key
-- (row.responsibleUnit ?? row.responsibleunit).
-- ============================================================================

ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS responsibleunit TEXT;
