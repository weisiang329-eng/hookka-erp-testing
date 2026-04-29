-- ---------------------------------------------------------------------------
-- 0093_service_cases_case_prefix_backfill.sql
--
-- Backfill old "CASE-YYMM-NNN" rows to the new "SC-YYMM-NNN" prefix so all
-- service cases share one prefix. The generator was switched from "CASE-"
-- to "SC-" in src/api/routes/service-cases.ts; the count query already
-- includes both prefixes during the transition, so this rename is
-- non-disruptive (no number collisions can be produced).
--
-- Idempotent: only touches rows that still start with "CASE-". Re-running
-- is a no-op once all rows are migrated.
-- ---------------------------------------------------------------------------

UPDATE service_cases
   SET case_no = 'SC-' || SUBSTRING(case_no FROM 6)
 WHERE case_no LIKE 'CASE-%';
