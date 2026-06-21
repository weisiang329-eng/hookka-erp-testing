// ---------------------------------------------------------------------------
// material-cost-fifo.ts — PURE per-item FIFO material-cost engine (F6).
//
// MONEY-CRITICAL. No IO. The finance side re-computes P&L material cost (RM /
// WIP / FG) read-only by replaying every stock movement of a single raw-material
// item through a strict first-in-first-out layer queue, instead of trusting the
// perpetual cost_ledger (which stopped being fed after 2026-03). Data assembly
// (reading GRNs / cost_ledger / opening table / invoices) lives in
// accounting.ts; THIS file only does the FIFO maths so it can be unit-tested.
//
// All amounts are integer SEN (1 RM = 100 sen). Quantities may be fractional
// (kg, metres), so a layer's book value is round(qty × unitCostSen) and the
// cost of an issue is computed as the DECREASE in the eaten layers' book value.
// That keeps the identity  openingSen + purchaseSen − closingSen === consumedSen
// exact to the sen in the non-negative case, even with fractional quantities.
// ---------------------------------------------------------------------------

export type FifoEvent =
  | { kind: "receipt"; date: string; qty: number; unitCostSen: number }  // GRN / ADJUSTMENT IN / opening
  | { kind: "issue"; date: string; qty: number };                        // RM_ISSUE / ADJUSTMENT OUT

export type MaterialInput = {
  rmId: string;
  itemGroup: string;
  opening: { qty: number; unitCostSen: number } | null; // cutover seed layer
  openingDate: string;                                   // cutover day (YYYY-MM-DD)
  events: FifoEvent[];                                   // any order; engine sorts by date (stable)
};

export type MaterialPeriodResult = {
  rmId: string;
  itemGroup: string;
  openingSen: number;
  purchaseSen: number;
  closingSen: number;
  consumedSen: number;
  negativeUnits: number; // issued quantity with no layer to draw from (negative-stock flag)
};

type Layer = { qty: number; unitCostSen: number };

// Book value of a layer = round(qty × unitCostSen). qty can be fractional; sen
// are integers. Rounding once per layer (never per partial eat in isolation)
// is what keeps the period identity airtight — issue cost is derived as the
// difference of two such book values, so the rounding cancels.
function layerValueSen(qty: number, unitCostSen: number): number {
  return Math.round(qty * unitCostSen);
}

// Total book value of a layer queue.
function queueValueSen(layers: Layer[]): number {
  let sum = 0;
  for (const l of layers) sum += layerValueSen(l.qty, l.unitCostSen);
  return sum;
}

// Replay one item's full history through a FIFO layer queue and snapshot the
// four period figures. Events with date < startIso fold into the opening
// snapshot; events in [startIso, endIso] count toward this period; events with
// date > endIso are ignored. Date comparison is plain ISO-string compare
// (same-length YYYY-MM-DD ⇒ lexicographic == chronological).
export function computeMaterialPeriod(
  m: MaterialInput,
  startIso: string,
  endIso: string,
): MaterialPeriodResult {
  // Merge the opening balance in as a receipt dated at openingDate.
  const all: FifoEvent[] = [];
  if (m.opening && (m.opening.qty !== 0 || m.opening.unitCostSen !== 0)) {
    all.push({ kind: "receipt", date: m.openingDate, qty: m.opening.qty, unitCostSen: m.opening.unitCostSen });
  }
  for (const e of m.events) all.push(e);

  // Stable sort by date: Array.prototype.sort is stable in modern V8/Node, so
  // equal-date events keep their original order (opening first, then events as
  // given) — important when a receipt and an issue land on the same day.
  const sorted = all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map((x) => x.e);

  const layers: Layer[] = [];
  let purchaseSen = 0;
  let consumedSen = 0;
  let negativeUnits = 0;
  let lastUnitCostSen = 0; // last layer cost touched; values negative-stock excess
  let openingSen: number | null = null; // captured the moment we cross into the period

  const captureOpening = () => {
    if (openingSen === null) openingSen = queueValueSen(layers);
  };

  for (const ev of sorted) {
    if (ev.date > endIso) break; // sorted ascending ⇒ everything after is also > end
    const inPeriod = ev.date >= startIso; // ev.date <= endIso already guaranteed
    if (inPeriod) captureOpening(); // snapshot BEFORE applying the first in-period event

    if (ev.kind === "receipt") {
      lastUnitCostSen = ev.unitCostSen;
      if (ev.qty > 0) {
        layers.push({ qty: ev.qty, unitCostSen: ev.unitCostSen });
        if (inPeriod) purchaseSen += layerValueSen(ev.qty, ev.unitCostSen);
      }
    } else {
      // issue: eat FIFO from the front, costing each chunk as the drop in that
      // layer's book value so partial-layer rounding cancels against closing.
      let need = ev.qty;
      let cost = 0;
      while (need > 0 && layers.length > 0) {
        const layer = layers[0];
        lastUnitCostSen = layer.unitCostSen;
        const before = layerValueSen(layer.qty, layer.unitCostSen);
        if (layer.qty > need) {
          const after = layerValueSen(layer.qty - need, layer.unitCostSen);
          cost += before - after;
          layer.qty -= need;
          need = 0;
        } else {
          cost += before; // whole layer consumed
          need -= layer.qty;
          layers.shift();
        }
      }
      if (need > 0) {
        // No layers left: value the excess at the last known unit cost (0 if
        // the item never had a layer). Flag the units as negative stock.
        negativeUnits += need;
        cost += Math.round(need * lastUnitCostSen);
        need = 0;
      }
      if (inPeriod) consumedSen += cost;
    }
  }

  // If no in-period event ever fired (e.g. opening only, or all events before
  // start), the opening snapshot is the current queue value.
  captureOpening();
  const closingSen = queueValueSen(layers);

  return {
    rmId: m.rmId,
    itemGroup: m.itemGroup,
    openingSen: openingSen ?? 0,
    purchaseSen,
    closingSen,
    consumedSen,
    negativeUnits,
  };
}

// Aggregate per-item results into item-group rows + grand totals, and collect
// every item that went negative so the report can flag it.
export function rollupByGroup(rs: MaterialPeriodResult[]): {
  groups: { itemGroup: string; openingSen: number; purchaseSen: number; closingSen: number; consumedSen: number }[];
  totals: { openingSen: number; purchaseSen: number; closingSen: number; consumedSen: number };
  negatives: { rmId: string; negativeUnits: number }[];
} {
  const byGroup = new Map<string, { itemGroup: string; openingSen: number; purchaseSen: number; closingSen: number; consumedSen: number }>();
  const totals = { openingSen: 0, purchaseSen: 0, closingSen: 0, consumedSen: 0 };
  const negatives: { rmId: string; negativeUnits: number }[] = [];

  for (const r of rs) {
    let g = byGroup.get(r.itemGroup);
    if (!g) {
      g = { itemGroup: r.itemGroup, openingSen: 0, purchaseSen: 0, closingSen: 0, consumedSen: 0 };
      byGroup.set(r.itemGroup, g);
    }
    g.openingSen += r.openingSen;
    g.purchaseSen += r.purchaseSen;
    g.closingSen += r.closingSen;
    g.consumedSen += r.consumedSen;

    totals.openingSen += r.openingSen;
    totals.purchaseSen += r.purchaseSen;
    totals.closingSen += r.closingSen;
    totals.consumedSen += r.consumedSen;

    if (r.negativeUnits > 0) negatives.push({ rmId: r.rmId, negativeUnits: r.negativeUnits });
  }

  return { groups: [...byGroup.values()], totals, negatives };
}
