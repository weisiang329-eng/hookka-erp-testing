-- ============================================================================
-- 0165 — Service Case linkage on SV Service Orders.
--
-- sales_orders.caseid:
--   Optional service_cases.id backlink, set when a Service Order
--   (is_service_order=TRUE) is created via /service-order/create?fromCase=…
--   (the case detail page's "Spawn Service Order" hand-off). The case detail
--   "Service Orders" panel (src/api/routes/service-cases.ts) merges these
--   sales_orders rows with the legacy service_orders list so spawned
--   production-backed orders show on the case. NULL on every normal SO.
--
-- ⚠ ADAPTER RULE: also self-applied at runtime (sales-orders.ts
-- ensurePendingMigrations + service-cases.ts ensureCaseLinkColumns) with the
-- lowercase name, so a tool apply is a no-op on databases where the runtime
-- already created it. Reads are dual-key (row.caseId ?? row.caseid).
-- ============================================================================

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS caseid TEXT;
