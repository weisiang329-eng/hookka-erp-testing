-- ============================================================================
-- 0088_hotfix_org_id_core_tables.sql
--
-- HOTFIX (2026-04-29): migration 0049_multi_tenant_skeleton was never
-- applied to Postgres during the D1->Postgres conversion. Production
-- went live on 2026-04-29 with new code that does WHERE org_id = ?
-- against tables that didn't have the column. Result: every list
-- endpoint returned 0 rows even though the data existed.
--
-- Fix: add org_id to the 6 core tables 0049 was supposed to cover,
-- backfill 'hookka' so existing data shows up under the user's session.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- Re-running is a no-op once these columns exist.
--
-- Lesson learned -> see docs/PRE-DEPLOY-CHECKLIST.md.
-- ============================================================================

ALTER TABLE users             ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE sales_orders      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE customers         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE invoices          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE audit_events      ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_users_org_id             ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_sales_orders_org_id      ON sales_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_customers_org_id         ON customers(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org_id          ON invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_org_id ON production_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_org_id      ON audit_events(org_id);
