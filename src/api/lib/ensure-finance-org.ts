import type { Env } from "../worker";

// ---------------------------------------------------------------------------
// ensure-finance-org.ts — Multi-company finance foundation (Phase 1).
//
// Runtime self-apply of `org_id` on the finance tables that lack it and are
// needed for per-company rollups. Migrations do NOT auto-apply on deploy (see
// CLAUDE.md) — the canonical DDL lives in migrations-postgres/0087_org_id_
// full_rollout.sql and migrations-postgres/0206_finance_org_id.sql, but the
// column reaches PROD only via this awaited runtime ensure. This is what makes
// the optional `?orgId=` / `?company=` filter on the finance reports safe: the
// column it filters on is guaranteed to exist before the first query runs.
//
// Tables covered (all additive):
//   · purchase_invoices  — AP subledger source (aging / ap-control).
//   · suppliers          — AP control-account outstanding rollup.
//   · cost_ledger        — already queried `WHERE orgId = ?` in the material-
//                          cost P&L path; the column is added here defensively
//                          so that path can never 500 on a partial deploy.
//   · journal_entries    — legacy manual adjusting-entry parent (routes-d1 JE UI).
//   · journal_lines      — its child rows.
//   · ar_aging / ap_aging — dead snapshot tables today, but adding the column
//                          keeps them consistent for any future per-org rebuild.
//
// The `org_id TEXT NOT NULL DEFAULT 'hookka'` default IS the backfill: every
// existing row (all under 'hookka' today) picks up the default in-place, so the
// default-filter (no `?orgId`) view stays byte-identical to today.
//
// Idempotent: `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` are cheap
// no-ops once applied. Each statement is wrapped in try/catch so a missing table
// or a no-DDL-perms environment degrades gracefully rather than failing the
// report. Memoised per isolate so it runs at most once per Worker instance.
// ---------------------------------------------------------------------------

const FINANCE_ORG_STATEMENTS: readonly string[] = [
  "ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE ar_aging ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "ALTER TABLE ap_aging ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'hookka'",
  "CREATE INDEX IF NOT EXISTS idx_purchase_invoices_org_id ON purchase_invoices(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_suppliers_org_id ON suppliers(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_cost_ledger_org_id ON cost_ledger(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_journal_entries_org_id ON journal_entries(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id ON journal_lines(org_id)",
];

let financeOrgPromise: Promise<void> | null = null;

export function ensureFinanceOrgColumns(db: Env["Variables"]["DB"]): Promise<void> {
  if (financeOrgPromise) return financeOrgPromise;
  financeOrgPromise = (async () => {
    let hadFailure = false;
    for (const sql of FINANCE_ORG_STATEMENTS) {
      try {
        await db.prepare(sql).run();
      } catch {
        // Best-effort: table missing / no DDL perms. Readers fall back to the
        // unfiltered (all-org) path, which is the correct default behaviour.
        hadFailure = true;
      }
    }
    // Self-heal: if a transient DDL reject occurred, clear the memo so the next
    // request retries rather than caching a partial-apply as "done".
    if (hadFailure) financeOrgPromise = null;
  })();
  return financeOrgPromise;
}
