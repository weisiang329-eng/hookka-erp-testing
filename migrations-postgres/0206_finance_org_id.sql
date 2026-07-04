-- ---------------------------------------------------------------------------
-- 0206_finance_org_id.sql — Multi-company finance foundation (Phase 1).
--
-- Adds `org_id` to the finance tables needed for per-company (per sister
-- company) rollups of the P&L / Balance Sheet / AR & AP aging. This is the
-- schema half of Phase 1; the OPTIONAL `?orgId=` / `?company=` filter on the
-- finance reports scopes on these columns.
--
-- ADDITIVE ONLY. `org_id TEXT NOT NULL DEFAULT 'hookka'` backfills every
-- existing row in-place (all live data is under 'hookka' today), so the
-- default report view — no `?orgId` param, no WHERE change — stays byte-
-- identical to today. This is the reconciliation contract.
--
-- Migrations do NOT auto-apply on deploy (see CLAUDE.md). The load-bearing
-- copy of these ALTERs is the runtime self-apply in
-- src/api/lib/ensure-finance-org.ts (ensureFinanceOrgColumns), awaited at the
-- top of the finance report handlers before the first filtered query. This
-- file is the canonical record + the path that runs when the incremental
-- Postgres applier is used.
--
-- Overlaps intentionally with 0087_org_id_full_rollout.sql (which already
-- listed most of these). `ADD COLUMN IF NOT EXISTS` makes the overlap a cheap
-- no-op — this file re-states the finance subset so the Phase-1 intent is
-- self-contained and re-runnable regardless of whether 0087 was applied.
--
-- chart_of_accounts is intentionally SHARED (one group chart across all orgs)
-- and is NOT scoped here.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS purchase_invoices ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS suppliers         ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS cost_ledger       ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS journal_entries   ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS journal_lines     ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS ar_aging          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';
ALTER TABLE IF EXISTS ap_aging          ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka';

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_id ON purchase_invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_org_id         ON suppliers(org_id);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_org_id       ON cost_ledger(org_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id   ON journal_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id     ON journal_lines(org_id);
