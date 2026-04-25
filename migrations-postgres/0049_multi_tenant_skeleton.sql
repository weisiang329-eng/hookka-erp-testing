-- ---------------------------------------------------------------------------
-- 0049_multi_tenant_skeleton.sql — Postgres mirror of migrations/0049.
--
-- Per docs/d1-retirement-plan.md the live data lives in Supabase, not D1.
-- D1 migration files are kept for parity / rollback only; the actual ALTER
-- runs against Postgres via supabase CLI or psql, in snake_case.
-- ---------------------------------------------------------------------------

ALTER TABLE sales_orders        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE customers           ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE invoices            ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE production_orders   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE audit_events        ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE users               ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_sales_orders_org      ON sales_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_customers_org         ON customers(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org          ON invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_org ON production_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_org      ON audit_events(org_id);
CREATE INDEX IF NOT EXISTS idx_users_org             ON users(org_id);
