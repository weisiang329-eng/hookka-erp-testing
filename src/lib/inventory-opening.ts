// ---------------------------------------------------------------------------
// inventory-opening.ts — Task 2.2: WIP / finished-goods opening-stock seed.
//
// The system reconstructs WIP and finished-goods value from production orders
// and fg_batches, but it has no pre-opening transactional history — so at the
// accounting cutover it cannot know the WIP/FG already on hand. The owner's
// 30/04 stock-take provides those totals. We store them in `inventory_opening`
// and inject them into the per-month-end WIP/FG snapshots AT THE CUTOVER MONTH,
// so they surface as the FIRST system month's OPENING and are absorbed into
// that month's COGS — the "consumed in month one" model the owner approved
// (see 财务模块-存货期初与历史PNL-设计.md §3b).
//
// Pure + dependency-free so it is unit-testable without Worker / D1.
// ---------------------------------------------------------------------------

export type InventoryLayer = "WIP" | "FG";

export type InventoryOpeningSeed = {
  wipSen: number;
  fgSen: number;
  asOfDate: string | null; // YYYY-MM-DD — the cutover stock-take date
};

// Raw inventory_opening row. The Postgres adapter (db-pg.ts) camelCases result
// columns (value_sen → valueSen, as_of_date → asOfDate), so read dual-keyed
// `camelCase ?? snake_case` (repo gotcha — see BUG-2026-06-30-001).
export type InventoryOpeningRow = {
  layer?: string | null;
  valueSen?: number | null;
  value_sen?: number | null;
  asOfDate?: string | null;
  as_of_date?: string | null;
};

/** Fold raw inventory_opening rows into one {wipSen, fgSen, asOfDate} seed. */
export function buildInventoryOpeningSeed(rows: InventoryOpeningRow[]): InventoryOpeningSeed {
  let wipSen = 0;
  let fgSen = 0;
  let asOfDate: string | null = null;
  for (const r of rows) {
    const valueSen = Number(r.valueSen ?? r.value_sen ?? 0) || 0;
    const d = r.asOfDate ?? r.as_of_date ?? null;
    if (d && asOfDate === null) asOfDate = d;
    if (r.layer === "WIP") wipSen += valueSen;
    else if (r.layer === "FG") fgSen += valueSen;
  }
  return { wipSen, fgSen, asOfDate };
}

/**
 * Add an opening seed to a by-month-end snapshot map at the cutover month
 * (the YYYY-MM of `asOfDate`), so the seed surfaces as the NEXT month's
 * opening (a window's opening = the prior month-end value). Mutates and
 * returns the same map. No-op when `seedSen` is 0 or `asOfDate` is
 * missing / not YYYY-MM-DD.
 */
export function applyOpeningSeed(
  byYm: Map<string, number>,
  seedSen: number,
  asOfDate: string | null,
): Map<string, number> {
  if (!seedSen || !asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return byYm;
  const ym = asOfDate.slice(0, 7);
  byYm.set(ym, (byYm.get(ym) ?? 0) + seedSen);
  return byYm;
}
