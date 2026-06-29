// ---------------------------------------------------------------------------
// cost-attribution.ts — pure per-production-order cost bucketing from
// cost_ledger rows, with as-of-date accessors. Extracted from accounting.ts so
// the ATTRIBUTION KEY (which column holds the PO) is locked by a unit test.
//
// MONEY-CRITICAL. The cost_ledger stores the owning production order in a
// DIFFERENT column per row type:
//   - RM_ISSUE      → the PO is in `refId`   (itemId is the raw-material id;
//                       postJobCardLabor/consumeRawMaterialsForPO write
//                       refType='PRODUCTION_ORDER', refId=poId).
//   - LABOR_POSTED  → the PO is in `itemId`  (refType='JOB_CARD', refId=the job
//                       card id; postJobCardLabor writes itemId=productionOrderId).
// This is the same split costByLineWindow uses
// (`poId = type === 'RM_ISSUE' ? refId : itemId`). Bucketing LABOR_POSTED by
// refId (the JOB CARD) — as an earlier WIP/FG resolver did — makes every per-PO
// lookup miss, so labour silently dropped to 0 in WIP and finished-goods cost.
// ---------------------------------------------------------------------------

/** A cost_ledger row, only the fields the per-PO bucketing needs. */
export type LedgerCostRow = {
  type: string;
  /** Raw-material id for RM_ISSUE; production-order id for LABOR_POSTED. */
  itemId: string | null;
  /** Production-order id for RM_ISSUE; job-card id for LABOR_POSTED. */
  refId: string | null;
  date: string | null;
  totalCostSen: number | null;
};

/** Which column carries the owning production order, by ledger row type. */
export function poKeyForLedgerType(type: string): "refId" | "itemId" {
  // LABOR_POSTED keeps the PO in itemId; everything else (RM_ISSUE/ADJUSTMENT)
  // keeps it in refId. Mirrors costByLineWindow's split exactly.
  return type === "LABOR_POSTED" ? "itemId" : "refId";
}

/**
 * Bucket the given ledger rows of `wantType` by their owning production order
 * (using {@link poKeyForLedgerType}) and return `asOf(poId, dIso)` = Σ
 * totalCostSen for that PO with date ≤ dIso. Rows with no PO key or no date are
 * ignored. Dates compare on their YYYY-MM-DD prefix (ISO-sortable).
 *
 * Only the row's OWN PO is credited — a PO's cost never includes another PO's
 * rows — which is the property the regression test locks.
 */
export function costAsOfByPo(
  rows: Iterable<LedgerCostRow>,
  wantType: string,
): (poId: string, dIso: string) => number {
  const key = poKeyForLedgerType(wantType);
  const byPo = new Map<string, { date: string; sen: number }[]>();
  for (const r of rows) {
    if (r.type !== wantType) continue;
    const po = key === "itemId" ? r.itemId : r.refId;
    if (!po) continue;
    const date = (r.date ?? "").slice(0, 10);
    if (!date) continue;
    let arr = byPo.get(po);
    if (!arr) {
      arr = [];
      byPo.set(po, arr);
    }
    arr.push({ date, sen: Number(r.totalCostSen) || 0 });
  }
  return (poId: string, dIso: string): number => {
    const arr = byPo.get(poId);
    if (!arr) return 0;
    let s = 0;
    for (const e of arr) if (e.date <= dIso) s += e.sen;
    return s;
  };
}
