-- ---------------------------------------------------------------------------
-- 0208_finance_org_id.sql — Multi-company finance foundation (Phase 1).
--
-- D1-side parity for migrations-postgres/0206_finance_org_id.sql. D1 was
-- retired 2026-04-27 (live runtime is Supabase Postgres); this file exists for
-- record parity. The load-bearing apply on prod is the runtime self-apply in
-- src/api/lib/ensure-finance-org.ts.
--
-- Adds `org_id` (d1-compat maps orgId <-> org_id) to the finance tables needed
-- for per-company P&L / Balance Sheet / AR & AP aging rollups. ADDITIVE ONLY:
-- `DEFAULT 'hookka'` backfills existing rows in-place so the default (no
-- ?orgId filter) report view stays byte-identical.
-- ---------------------------------------------------------------------------

ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE suppliers         ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE cost_ledger       ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE journal_entries   ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE journal_lines     ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE ar_aging          ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE ap_aging          ADD COLUMN IF NOT EXISTS orgId TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_id ON purchase_invoices(orgId);
CREATE INDEX IF NOT EXISTS idx_suppliers_org_id         ON suppliers(orgId);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_org_id       ON cost_ledger(orgId);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id   ON journal_entries(orgId);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id     ON journal_lines(orgId);
