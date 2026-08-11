// ---------------------------------------------------------------------------
// Trade-finance draw derivation — PURE. Amounts are never stored: a draw is
// the live ledger family net on the TF account keyed by the drawing payment's
// sourceId, so voids/edits/restates are correct by construction. Stored state
// is only per-draw due dates (trade_finance_draws) and repayment allocations
// (trade_finance_repay_allocs) — see src/api/lib/trade-finance.ts.
//
// Identity the aging block prints and the tests pin:
//   Σ draw outstanding + unallocated = TF account ledger net.
// ---------------------------------------------------------------------------

export type TfLegRow = { sourceType: string; sourceId: string; debitSen: number; creditSen: number };
export type TfDrawMeta = { drawSourceId: string; drawDate: string; dueDate: string };
export type TfAlloc = { repayPaymentNo: string; drawSourceId: string; amountSen: number };
export type TfDraw = {
  drawSourceId: string;
  drawDate: string;
  dueDate: string;
  amountSen: number;
  repaidSen: number;
  outstandingSen: number;
};

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function deriveDraws(
  legs: TfLegRow[],
  metas: TfDrawMeta[],
  allocs: TfAlloc[],
  repayNos: Set<string>,
): { draws: TfDraw[]; accountNetSen: number; unallocatedSen: number } {
  const metaBy = new Map(metas.map((m) => [m.drawSourceId, m] as const));
  const repaidBy = new Map<string, number>();
  for (const a of allocs) repaidBy.set(a.drawSourceId, (repaidBy.get(a.drawSourceId) ?? 0) + (Number(a.amountSen) || 0));
  const netBy = new Map<string, number>();
  let accountNetSen = 0;
  for (const l of legs) {
    const net = (Number(l.creditSen) || 0) - (Number(l.debitSen) || 0);
    accountNetSen += net;
    netBy.set(l.sourceId, (netBy.get(l.sourceId) ?? 0) + net);
  }
  const draws: TfDraw[] = [];
  for (const [sourceId, net] of netBy) {
    if (net <= 0 || repayNos.has(sourceId)) continue;
    const meta = metaBy.get(sourceId);
    const repaidSen = repaidBy.get(sourceId) ?? 0;
    draws.push({
      drawSourceId: sourceId,
      drawDate: meta?.drawDate ?? "",
      dueDate: meta?.dueDate ?? "",
      amountSen: net,
      repaidSen,
      outstandingSen: net - repaidSen,
    });
  }
  draws.sort(
    (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.drawDate.localeCompare(b.drawDate),
  );
  const unallocatedSen = accountNetSen - draws.reduce((s, d) => s + d.outstandingSen, 0);
  return { draws, accountNetSen, unallocatedSen };
}

export function tfBucketOf(dueDate: string, todayIso: string): "notDue" | "d1_30" | "d31_60" | "d61_90" | "over90" {
  if (!dueDate || dueDate >= todayIso) return "notDue";
  const days = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "over90";
}

export function tfTotals(draws: TfDraw[], todayIso: string) {
  const t = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const d of draws) {
    t[tfBucketOf(d.dueDate, todayIso)] += d.outstandingSen;
    t.total += d.outstandingSen;
  }
  return t;
}

export function clampRepayAlloc(outstandingSen: number, paySen: number): { ok: boolean; error?: string } {
  if (!(paySen > 0)) return { ok: false, error: "allocation must be positive" };
  if (paySen > outstandingSen) return { ok: false, error: "allocation exceeds the draw's outstanding balance" };
  return { ok: true };
}
