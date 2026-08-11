import type { Env } from "../worker";
import { addDays, deriveDraws } from "../../lib/trade-finance";
import type { TfAlloc, TfDraw, TfDrawMeta, TfLegRow } from "../../lib/trade-finance";

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

// The ONE derivation every reader shares (aging section, TF endpoint, the
// repayment branch's outstanding check) — so no two surfaces can disagree.
// Also SELF-HEALS: a ledger-derived draw with no meta row gets one, due date
// = the payment's document date + tenor. That is the backfill for the draws
// that existed before this feature, and the forever safety-net for strays
// (e.g. an expense voucher paid from the TF account).
export async function loadTfDraws(
  db: DB,
  source: TfSource,
): Promise<{ draws: TfDraw[]; accountNetSen: number; unallocatedSen: number }> {
  await ensureTfTables(db);
  const legsRes = await db
    .prepare(
      `SELECT sourceType, sourceId, debitSen, creditSen
         FROM ledger_journal_entries WHERE accountCode = ? AND hidden = 0`,
    )
    .bind(source.accountCode)
    .all<Record<string, unknown>>();
  const legs: TfLegRow[] = (legsRes.results ?? []).map((r) => ({
    sourceType: String(r.sourceType ?? r.source_type ?? ""),
    sourceId: String(r.sourceId ?? r.source_id ?? ""),
    debitSen: Number(r.debitSen ?? r.debit_sen) || 0,
    creditSen: Number(r.creditSen ?? r.credit_sen) || 0,
  }));
  const metasRes = await db
    .prepare(`SELECT draw_source_id, draw_date, due_date FROM trade_finance_draws WHERE account_code = ?`)
    .bind(source.accountCode)
    .all<Record<string, unknown>>();
  const metas: TfDrawMeta[] = (metasRes.results ?? []).map((r) => ({
    drawSourceId: String(r.drawSourceId ?? r.draw_source_id ?? ""),
    drawDate: String(r.drawDate ?? r.draw_date ?? "").slice(0, 10),
    dueDate: String(r.dueDate ?? r.due_date ?? "").slice(0, 10),
  }));
  const allocsRes = await db
    .prepare(`SELECT repay_payment_no, draw_source_id, amount_sen FROM trade_finance_repay_allocs`)
    .all<Record<string, unknown>>();
  const allocs: TfAlloc[] = (allocsRes.results ?? []).map((r) => ({
    repayPaymentNo: String(r.repayPaymentNo ?? r.repay_payment_no ?? ""),
    drawSourceId: String(r.drawSourceId ?? r.draw_source_id ?? ""),
    amountSen: Number(r.amountSen ?? r.amount_sen) || 0,
  }));
  const repayNos = new Set<string>(allocs.map((a) => a.repayPaymentNo));
  // A TF_REPAYMENT payment with zero alloc rows must still never read as a draw.
  try {
    const repRes = await db
      .prepare(`SELECT DISTINCT paymentNo FROM supplier_payments WHERE method = 'TF_REPAYMENT'`)
      .all<Record<string, unknown>>();
    for (const r of repRes.results ?? []) repayNos.add(String(r.paymentNo ?? r.payment_no ?? ""));
  } catch {
    /* very old DB without the table — allocs already cover it */
  }
  const derived = deriveDraws(legs, metas, allocs, repayNos);
  for (const d of derived.draws) {
    if (d.dueDate) continue;
    let drawDate = "";
    try {
      const p = await db
        .prepare(`SELECT date FROM supplier_payments WHERE paymentNo = ? LIMIT 1`)
        .bind(d.drawSourceId)
        .first<Record<string, unknown>>();
      drawDate = String(p?.date ?? "").slice(0, 10);
    } catch {
      /* not a supplier payment — fall through to today */
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(drawDate)) drawDate = new Date().toISOString().slice(0, 10);
    const dueDate = addDays(drawDate, source.tenorDays);
    await db
      .prepare(
        `INSERT INTO trade_finance_draws (draw_source_id, account_code, draw_date, due_date)
         VALUES (?, ?, ?, ?) ON CONFLICT (draw_source_id) DO NOTHING`,
      )
      .bind(d.drawSourceId, source.accountCode, drawDate, dueDate)
      .run();
    d.drawDate = drawDate;
    d.dueDate = dueDate;
  }
  // Healing may have filled due dates — re-sort by the same rule deriveDraws uses.
  derived.draws.sort(
    (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.drawDate.localeCompare(b.drawDate),
  );
  return derived;
}
