-- ============================================================================
-- 0164 — Service-replacement linkage on stock adjustments.
--
-- stock_adjustments.caseid:
--   Optional service_cases.id backlink, set by reason='SERVICE_REPLACEMENT'
--   adjustments (the "Replacement Parts (stock only)" card on the service
--   case detail page — top-ups like missing legs that deduct stock and keep
--   a record without a production order). NULL on every other adjustment.
--
-- ⚠ ADAPTER RULE: the column is ALSO self-applied at runtime by
-- src/api/routes/stock-adjustments.ts (ALTER ... IF NOT EXISTS) using the
-- lowercase name directly, so a tool apply is a no-op on databases where the
-- runtime already created it. Reads are dual-key (r.caseId ?? r.caseid).
-- ============================================================================

ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS caseid TEXT;
