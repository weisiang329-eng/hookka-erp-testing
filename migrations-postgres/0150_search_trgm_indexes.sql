-- ---------------------------------------------------------------------------
-- 0150_search_trgm_indexes.sql — pg_trgm GIN indexes for fast substring +
-- typo-tolerant search across the entities the operator searches.
--
-- WHY: the whole ERP had ZERO text-search indexes. Every `ILIKE '%term%'`
-- (the global-search smart_lookup, per-list search, etc.) was a sequential
-- scan. With pg_trgm GIN indexes a leading-wildcard `%term%` becomes an
-- index lookup (~tens of ms even on large tables) — the same trick Odoo
-- (`index='trigram'`) and ERPNext use on Postgres. These indexes also back
-- `similarity()` ranking for typo tolerance.
--
-- Columns chosen = exactly what operators type to find a record. For Sales
-- Orders that explicitly includes customer_po_id (the "Customer PO" column,
-- which stores the real customer PO number e.g. "PO/2606-016") — Wei Siang
-- 2026-06-04: "用顾客的 PO 来搜索…这个功能一定要有，一定要保持着的."
--
-- !! RUN OUTSIDE A TRANSACTION !!  (same as 0133 / 0148)
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
-- file is applied MANUALLY one statement at a time via the Supabase SQL
-- editor (the incremental migration runner wraps each file in a tx and would
-- fail on CONCURRENTLY). CONCURRENTLY = no ACCESS EXCLUSIVE lock, so the
-- factory's live writes/scanning are never blocked while the index builds.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Sales orders — the operator's primary search surface.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_companysoid_trgm ON sales_orders     USING gin (company_so_id  gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_custsoid_trgm    ON sales_orders     USING gin (customer_so_id gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_custpoid_trgm    ON sales_orders     USING gin (customer_po_id gin_trgm_ops);  -- "Customer PO" search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_custname_trgm    ON sales_orders     USING gin (customer_name  gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_so_reference_trgm   ON sales_orders     USING gin (reference      gin_trgm_ops);

-- Production orders.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_pono_trgm      ON production_orders USING gin (po_no          gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_custpoid_trgm  ON production_orders USING gin (customer_po_id gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_prodcode_trgm  ON production_orders USING gin (product_code   gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_prodname_trgm  ON production_orders USING gin (product_name   gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_custname_trgm  ON production_orders USING gin (customer_name  gin_trgm_ops);

-- Delivery orders.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_do_dono_trgm        ON delivery_orders   USING gin (do_no          gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_do_custname_trgm    ON delivery_orders   USING gin (customer_name  gin_trgm_ops);

-- Invoices.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_invno_trgm      ON invoices          USING gin (invoice_no     gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_custname_trgm   ON invoices          USING gin (customer_name  gin_trgm_ops);

-- Reference data (customers / products / workers / suppliers).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cust_name_trgm      ON customers         USING gin (name           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cust_code_trgm      ON customers         USING gin (code           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prods_name_trgm     ON products          USING gin (name           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prods_code_trgm     ON products          USING gin (code           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workers_name_trgm   ON workers           USING gin (name           gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_suppliers_name_trgm ON suppliers         USING gin (name           gin_trgm_ops);
