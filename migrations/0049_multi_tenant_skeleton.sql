-- ---------------------------------------------------------------------------
-- 0049_multi_tenant_skeleton.sql — Phase C #1 quick-win.
--
-- Adds an orgId scope column to the 5 highest-leak tables so a future second
-- tenant cannot see Hookka rows (and vice versa). Defaults to 'hookka' on
-- every existing row so the rollout is zero-impact: existing queries keep
-- returning the same data, the WHERE filter just becomes a no-op until a
-- second org_id value enters the system.
--
-- Per docs/ROADMAP-PHASE-C.md §1 quick-win (5 leak-critical tables). The
-- doc lists `inventory_balances` but no such table exists in this schema —
-- production_orders is the closest equivalent (inventory is keyed off PO),
-- so the quick-win covers production_orders instead.
--
-- The middleware that consumes this column lives in src/api/lib/tenant.ts
-- (added in the same commit). Routes adopt the helper one at a time;
-- sales-orders.ts GET / is the first to flip.
--
-- D1 conventions (matches 0001_init.sql / 0046_audit_events.sql):
--   * camelCase column names — d1-compat rewrites to snake_case for Postgres.
--   * NOT NULL DEFAULT 'hookka' so existing rows backfill in-place; no
--     follow-up UPDATE needed.
--   * IF NOT EXISTS on every CREATE INDEX so the migration is re-runnable.
--
-- The other tables flagged in the roadmap (suppliers, customer_addresses,
-- DOs, payments, BOM templates, inventory_movements, etc.) are deferred to
-- the §1 finish step — see roadmap M1/W3-W4. Once this lands the read-side
-- middleware is wired and the long tail can be batched safely.
-- ---------------------------------------------------------------------------

ALTER TABLE sales_orders        ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE customers           ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE invoices            ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE production_orders   ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE audit_events        ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';

-- users gets it too — the JWT-side scope is read off users.orgId. Default
-- 'hookka' covers existing rows; future invites populate per active org.
ALTER TABLE users               ADD COLUMN orgId TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_sales_orders_org      ON sales_orders(orgId);
CREATE INDEX IF NOT EXISTS idx_customers_org         ON customers(orgId);
CREATE INDEX IF NOT EXISTS idx_invoices_org          ON invoices(orgId);
CREATE INDEX IF NOT EXISTS idx_production_orders_org ON production_orders(orgId);
CREATE INDEX IF NOT EXISTS idx_audit_events_org      ON audit_events(orgId);
CREATE INDEX IF NOT EXISTS idx_users_org             ON users(orgId);
