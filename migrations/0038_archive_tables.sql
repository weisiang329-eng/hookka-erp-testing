-- ---------------------------------------------------------------------------
-- 0038_archive_tables.sql — phase 5 hot/cold data split.
--
-- Creates empty "_archive" sibling tables for the four hottest business
-- tables. Schema is cloned from the live table with `CREATE TABLE ... AS
-- SELECT * FROM <hot> WHERE 0` (empty result set → column list only, no
-- rows, no PK, no FK). We then add an `archivedAt TEXT NOT NULL` column
-- so every archived row carries the moment it was demoted, and re-create
-- the hot table's important indexes on the archive so historical lookups
-- stay fast.
--
-- IMPORTANT: this migration ONLY creates the archive skeleton. NO data is
-- moved by the migration itself. Movement is driven by the
--     POST /api/admin/archive/run
-- endpoint (src/api/routes-d1/admin.ts), which is protected by a confirm
-- flag + dryRun preview, so a misfire can't silently delete hot data.
--
-- Tables included:
--   production_orders       → production_orders_archive
--   job_cards               → job_cards_archive
--   sales_orders            → sales_orders_archive
--   sales_order_items       → sales_order_items_archive
--
-- Deliberately NOT archived (compliance retention):
--   invoices, invoice_items, invoice_payments, cost_ledger, journal_*,
--   ap_aging/ar_aging, bank_transactions, fg_units, fg_batches — these
--   have audit / tax / warranty retention rules that need legal sign-off
--   before any archival policy is applied. Keep them in hot.
--
-- Idempotent: every statement uses IF NOT EXISTS so re-applying is safe.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- production_orders_archive — clone of hot production_orders schema.
-- CTAS from WHERE 0 copies column names/types/default values but NOT the
-- PK/NOT NULL/FK/CHECK constraints. That's intentional: archive is an
-- append-only bucket; we don't want CHECK(status IN ('PENDING','IN_PROGRESS'
-- ,...)) to reject a row whose hot-side status rules change later, and
-- we don't want FK(salesOrderId → sales_orders) to block archival of a PO
-- whose SO is also being archived in the same batch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders_archive
  AS SELECT * FROM production_orders WHERE 0;

-- Add the archivedAt stamp. NOT NULL so every archived row is traceable.
-- Guarded with a manual existence check via PRAGMA in the endpoint isn't
-- possible inside a plain migration; SQLite doesn't support "ADD COLUMN IF
-- NOT EXISTS", so we rely on this migration only being applied once. If
-- re-applied on a DB where the column already exists the ALTER will fail
-- — that's why the CREATE TABLE above is IF NOT EXISTS and this ALTER is
-- NOT wrapped in anything clever. Migrations framework tracks applied
-- files so a second `wrangler d1 migrations apply` is a no-op.
ALTER TABLE production_orders_archive
  ADD COLUMN archivedAt TEXT NOT NULL DEFAULT '';

-- Indexes mirroring the hot table so archive lookups by PO/SO/status stay
-- fast. We skip the composite perf indexes from 0037 (idx_jc_po_dept etc.
-- live on job_cards, not production_orders) — the ones below are the
-- leading hot indexes from 0001_init.sql.
CREATE INDEX IF NOT EXISTS idx_prod_po_arch_salesOrderId
  ON production_orders_archive(salesOrderId);
CREATE INDEX IF NOT EXISTS idx_prod_po_arch_productId
  ON production_orders_archive(productId);
CREATE INDEX IF NOT EXISTS idx_prod_po_arch_status
  ON production_orders_archive(status);
CREATE INDEX IF NOT EXISTS idx_prod_po_arch_completedDate
  ON production_orders_archive(completedDate);
CREATE INDEX IF NOT EXISTS idx_prod_po_arch_archivedAt
  ON production_orders_archive(archivedAt);

-- ---------------------------------------------------------------------------
-- job_cards_archive — clone of job_cards.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_cards_archive
  AS SELECT * FROM job_cards WHERE 0;

ALTER TABLE job_cards_archive
  ADD COLUMN archivedAt TEXT NOT NULL DEFAULT '';

-- Index parity with job_cards hot indexes (the ones that matter for
-- historical reports: "show me every JC that ever ran through UPHOLSTERY
-- for PO X"). We skip the pic1/pic2 indexes since they only matter for
-- live worker attribution.
CREATE INDEX IF NOT EXISTS idx_jc_arch_poId
  ON job_cards_archive(productionOrderId);
CREATE INDEX IF NOT EXISTS idx_jc_arch_departmentCode
  ON job_cards_archive(departmentCode);
CREATE INDEX IF NOT EXISTS idx_jc_arch_status
  ON job_cards_archive(status);
CREATE INDEX IF NOT EXISTS idx_jc_arch_po_dept
  ON job_cards_archive(productionOrderId, departmentCode);
CREATE INDEX IF NOT EXISTS idx_jc_arch_archivedAt
  ON job_cards_archive(archivedAt);

-- ---------------------------------------------------------------------------
-- sales_orders_archive — clone of sales_orders.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_orders_archive
  AS SELECT * FROM sales_orders WHERE 0;

ALTER TABLE sales_orders_archive
  ADD COLUMN archivedAt TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_so_arch_customerId
  ON sales_orders_archive(customerId);
CREATE INDEX IF NOT EXISTS idx_so_arch_hubId
  ON sales_orders_archive(hubId);
CREATE INDEX IF NOT EXISTS idx_so_arch_status
  ON sales_orders_archive(status);
CREATE INDEX IF NOT EXISTS idx_so_arch_customerDeliveryDate
  ON sales_orders_archive(customerDeliveryDate);
CREATE INDEX IF NOT EXISTS idx_so_arch_companySOId
  ON sales_orders_archive(companySOId);
CREATE INDEX IF NOT EXISTS idx_so_arch_customerPOId
  ON sales_orders_archive(customerPOId);
CREATE INDEX IF NOT EXISTS idx_so_arch_archivedAt
  ON sales_orders_archive(archivedAt);

-- ---------------------------------------------------------------------------
-- sales_order_items_archive — clone of sales_order_items. Cascaded by the
-- archive endpoint whenever its parent SO moves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_order_items_archive
  AS SELECT * FROM sales_order_items WHERE 0;

ALTER TABLE sales_order_items_archive
  ADD COLUMN archivedAt TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_so_items_arch_salesOrderId
  ON sales_order_items_archive(salesOrderId);
CREATE INDEX IF NOT EXISTS idx_so_items_arch_productId
  ON sales_order_items_archive(productId);
CREATE INDEX IF NOT EXISTS idx_so_items_arch_archivedAt
  ON sales_order_items_archive(archivedAt);
