import type { Env } from "../worker";

// ---------------------------------------------------------------------------
// Trade-finance storage (owner 2026-08-11) — the DB half of the feature whose
// maths lives in src/lib/trade-finance.ts.
//
// Two tables, runtime self-applied (migrations do NOT auto-apply — CLAUDE.md):
//   trade_finance_draws        — per-draw metadata ONLY (due date). A draw's
//                                amount is always derived from the ledger
//                                family net, never stored, so voids/edits
//                                can't leave a second set of numbers behind.
//   trade_finance_repay_allocs — which repayment paid down which draw.
// Config lives in kv 'trade_finance_sources': the accounts that ARE trade
// finance, who the lender is, and the default tenor. Generic on purpose —
// a second lender is one more row, no code.
// ---------------------------------------------------------------------------

type DB = Env["Variables"]["DB"];

export type TfSource = {
  accountCode: string;
  lenderSupplierId: string;
  lenderName: string;
  tenorDays: number;
};

export async function ensureTfTables(db: DB): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS trade_finance_draws (
         draw_source_id TEXT PRIMARY KEY,
         account_code   TEXT NOT NULL,
         draw_date      TEXT NOT NULL,
         due_date       TEXT NOT NULL,
         org_id         TEXT NOT NULL DEFAULT 'hookka-001'
       )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS trade_finance_repay_allocs (
         id               TEXT PRIMARY KEY,
         repay_payment_no TEXT NOT NULL,
         draw_source_id   TEXT NOT NULL,
         amount_sen       BIGINT NOT NULL,
         org_id           TEXT NOT NULL DEFAULT 'hookka-001'
       )`,
    )
    .run();
}

const TF_KV_KEY = "trade_finance_sources";

export async function getTfSources(db: DB): Promise<TfSource[]> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(TF_KV_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s) => {
        const o = (s ?? {}) as Partial<TfSource>;
        return {
          accountCode: String(o.accountCode ?? "").trim(),
          lenderSupplierId: String(o.lenderSupplierId ?? "").trim(),
          lenderName: String(o.lenderName ?? "").trim(),
          tenorDays: Math.max(1, Math.round(Number(o.tenorDays) || 90)),
        };
      })
      .filter((s) => s.accountCode && s.lenderSupplierId);
  } catch {
    return [];
  }
}

export async function saveTfSources(db: DB, sources: TfSource[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    )
    .bind(TF_KV_KEY, JSON.stringify(sources), new Date().toISOString())
    .run();
}
