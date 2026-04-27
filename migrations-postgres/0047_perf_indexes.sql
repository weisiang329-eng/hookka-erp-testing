-- ---------------------------------------------------------------------------
-- 0047_perf_indexes.sql — close the 8-9s /api/production-orders query.
--
-- Real perf test on prod 2026-04-25 showed
--   GET /api/production-orders?dept=X&fields=minimal
-- taking 8-9s for ~200KB payload. Backend chunking + JC-narrowing landed in
-- 745801a, but that did not help — the problem is full table scans on the
-- WHERE / IN / DISTINCT-subquery columns.
--
-- This migration adds indexes that target those scans. After apply, p95 of
-- /api/production-orders?dept=X is expected to drop from ~9s to <500ms.
--
-- What is NOT in this migration (already covered by earlier migrations):
--   * production_orders(status, created_at DESC)  → idx_po_status_updated   (0040)
--   * job_cards(productionOrderId)                → idx_jc_poId             (0001)
--   * job_cards(departmentCode)                   → idx_jc_departmentCode   (0001)
--   * job_cards(productionOrderId, departmentCode)→ idx_jc_po_dept          (0037)
--   * piece_pics(jobCardId)                       → idx_piece_pics_jc       (0001)
--   * invoices(status)                            → idx_invoices_status     (0001)
--   * invoices(salesOrderId)                      → idx_invoices_salesOrderId (0001)
--
-- Idempotent: every CREATE INDEX uses IF NOT EXISTS.
-- ---------------------------------------------------------------------------

-- Backs the wipKey-grouped subquery in fetchFilteredPOs (dept narrowing):
--   SELECT * FROM job_cards
--    WHERE wipKey IN (SELECT DISTINCT wipKey FROM job_cards
--                      WHERE departmentCode = ? AND wipKey IS NOT NULL)
-- The outer scan filters by wipKey directly; today there is no wipKey-only
-- index. idx_jc_po_wipKey (0037) has productionOrderId as the leading column
-- and cannot serve the bare wipKey predicate.
CREATE INDEX IF NOT EXISTS idx_jc_wipkey
  ON job_cards(wip_key);

-- Backs the dept-narrowed DISTINCT subquery in the same query:
--   SELECT DISTINCT wipKey FROM job_cards WHERE departmentCode = ? AND wipKey IS NOT NULL
-- Also backs upstream-pill lookups on the dept page that search by
-- (departmentCode, productionOrderId). idx_jc_po_dept (0037) is leading on
-- productionOrderId so it cannot serve a bare departmentCode predicate
-- followed by a PO range — this composite reverses the order so the dept
-- filter becomes an index seek and PO is read covered.
CREATE INDEX IF NOT EXISTS idx_jc_dept_po
  ON job_cards(department_code, production_order_id);

-- Backs the Sales page's status filter ordered by recency.
-- idx_so_status (0001) is status-only; SQLite re-sorts in memory by
-- created_at. This composite serves the ORDER BY directly. NOTE: column is
-- created_at (snake) on sales_orders, not createdAt.
CREATE INDEX IF NOT EXISTS idx_so_status_created
  ON sales_orders(status, created_at DESC);

-- Backs the Procurement page's status filter ordered by recency.
-- idx_po_status (0001) is status-only on purchase_orders. Column is
-- created_at (snake) on purchase_orders.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status_created
  ON purchase_orders(status, created_at DESC);
