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
  | { kind: "issue"; date: string; qty: number; ref?: string };          // RM_ISSUE / ADJUSTMENT OUT (ref = production_order)

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

// One row per issue event, with its FIFO cost computed by the SAME book-value-
// difference core as computeMaterialPeriod (so the two never drift). Used by the
// finance side to attribute material cost to production orders (WIP / FG).
export type IssueCost = {
  date: string;
  ref?: string;        // production_order id (cost_ledger.ref_id), if any
  qty: number;
  fifoCostSen: number; // FIFO cost of THIS single issue (sum of eaten-layer book-value drops + negative excess)
  negativeUnits: number;
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

// What the shared core reports back as it crosses the timeline. The core does
// NOT know about period windows — it just walks every event in order and hands
// each one to the caller, who decides what to accumulate. queueValueBefore is
// the layer-queue book value the instant BEFORE this event is applied (used to
// snapshot opening / closing). This keeps ONE FIFO implementation feeding both
// computeMaterialPeriod and valueIssues so they can never diverge.
type ReplayReceipt = {
  kind: "receipt";
  date: string;
  valueSen: number;
  queueValueBefore: number;
  queueValueAfter: number;
};
type ReplayIssue = {
  kind: "issue";
  date: string;
  ref?: string;
  qty: number;
  fifoCostSen: number;   // cost of this single issue (book-value drops + negative excess)
  negativeUnits: number; // units of this issue with no layer to draw from
  queueValueBefore: number;
  queueValueAfter: number;
};
type ReplayStep = ReplayReceipt | ReplayIssue;

// THE single FIFO replay. Merges the opening balance in as a receipt at
// openingDate, stable-sorts the whole timeline, walks a FIFO layer queue, and
// yields one ReplayStep per event (with this issue's FIFO cost). Returns the
// final queue value too. No period logic, no IO — the one source of truth for
// "how an issue is costed", shared by computeMaterialPeriod and valueIssues.
function replayFifo(m: MaterialInput, onStep: (step: ReplayStep) => void): { finalValueSen: number } {
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
  let lastUnitCostSen = 0; // last layer cost touched; values negative-stock excess

  for (const ev of sorted) {
    const queueValueBefore = queueValueSen(layers);

    if (ev.kind === "receipt") {
      lastUnitCostSen = ev.unitCostSen;
      const valueSen = ev.qty > 0 ? layerValueSen(ev.qty, ev.unitCostSen) : 0;
      if (ev.qty > 0) layers.push({ qty: ev.qty, unitCostSen: ev.unitCostSen });
      onStep({ kind: "receipt", date: ev.date, valueSen, queueValueBefore, queueValueAfter: queueValueSen(layers) });
    } else {
      // issue: eat FIFO from the front, costing each chunk as the drop in that
      // layer's book value so partial-layer rounding cancels against closing.
      let need = ev.qty;
      let cost = 0;
      let negativeUnits = 0;
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
      onStep({
        kind: "issue",
        date: ev.date,
        ref: ev.ref,
        qty: ev.qty,
        fifoCostSen: cost,
        negativeUnits,
        queueValueBefore,
        queueValueAfter: queueValueSen(layers),
      });
    }
  }

  return { finalValueSen: queueValueSen(layers) };
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
  let purchaseSen = 0;
  let consumedSen = 0;
  let negativeUnits = 0;
  let openingSen: number | null = null; // captured the moment we cross into the period
  let closingSen = 0;                    // actual queue value after the last event <= endIso

  replayFifo(m, (step) => {
    if (step.date > endIso) return; // ignore everything after the window
    // Closing = real layer-queue value after the latest in-window event. Taken
    // straight from the core (never reconstructed) so negative-stock issues —
    // whose cost exceeds the layer drop — don't push closing below zero.
    closingSen = step.queueValueAfter;

    const inPeriod = step.date >= startIso; // step.date <= endIso already guaranteed here
    if (!inPeriod) return;
    // Snapshot opening BEFORE the first in-period event is applied.
    if (openingSen === null) openingSen = step.queueValueBefore;

    if (step.kind === "receipt") {
      purchaseSen += step.valueSen;
    } else {
      consumedSen += step.fifoCostSen;
      negativeUnits += step.negativeUnits;
    }
  });

  // If no in-period event ever fired (opening only, or all events before start),
  // opening = closing — the queue didn't move inside the window.
  const resolvedOpening = openingSen ?? closingSen;

  return {
    rmId: m.rmId,
    itemGroup: m.itemGroup,
    openingSen: resolvedOpening,
    purchaseSen,
    closingSen,
    consumedSen,
    negativeUnits,
  };
}

// Replay the FULL timeline and return one IssueCost per issue event, each costed
// by the SAME shared core as computeMaterialPeriod (same book-value-difference
// method, same negative-stock handling). The finance side groups these by `ref`
// (production order) to value WIP / FG. Invariant guaranteed by construction:
// for any window, Σ fifoCostSen of issues with start <= date <= end ===
// computeMaterialPeriod(m, start, end).consumedSen — both read the same numbers
// from replayFifo, gated by the same date filter.
export function valueIssues(m: MaterialInput): IssueCost[] {
  const out: IssueCost[] = [];
  replayFifo(m, (step) => {
    if (step.kind !== "issue") return;
    out.push({
      date: step.date,
      ref: step.ref,
      qty: step.qty,
      fifoCostSen: step.fifoCostSen,
      negativeUnits: step.negativeUnits,
    });
  });
  return out;
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

// ---------------------------------------------------------------------------
// Single-pass monthly checkpoints (F6-v2 perf core).
//
// The slow path called computeMaterialPeriod once per item PER WINDOW, and the
// finance side called that per window (P&L = 2 windows, trend = 24) — so the
// whole FIFO timeline got replayed N_items × N_windows times. On real data
// (24k+ ledger rows) that blew the request budget and hung the P&L.
//
// Instead: replay each item ONCE and snapshot cumulative figures at every
// month-end. Any window [s,e] is then pure arithmetic on two snapshots — no
// re-replay. windowFromCheckpoints(cp@monthEnd(e), cp@monthEnd(prevMonth(s)))
// equals computeMaterialPeriod(m, `${s}-01`, monthEnd(e)) EXACTLY (tests fuzz
// this against the proven slow path). Every field is additive, so per-item
// checkpoints sum into per-group checkpoints and the identity still holds.
// ---------------------------------------------------------------------------

export type MonthCheckpoint = {
  monthEnd: string;          // YYYY-MM-DD, last day of the month
  closingSen: number;        // layer-queue book value as of end of this month
  cumPurchaseSen: number;    // Σ receipt value (incl. opening seed) for date <= monthEnd
  cumConsumedSen: number;    // Σ issue FIFO cost for date <= monthEnd
  cumNegativeUnits: number;  // Σ issue negative-stock units for date <= monthEnd
};

// The cumulative fields a window subtraction needs (item- or group-level).
export type CheckpointCum = {
  closingSen: number;
  cumPurchaseSen: number;
  cumConsumedSen: number;
  cumNegativeUnits: number;
};

// Replay one item ONCE and emit a snapshot for each requested month-end.
// `monthEnds` MUST be ascending YYYY-MM-DD (last-day-of-month) strings. A month
// with no activity carries the previous running totals forward; month-ends
// before the first event get zeros. One snapshot is returned per input month-end.
export function computeMaterialCheckpoints(m: MaterialInput, monthEnds: string[]): MonthCheckpoint[] {
  const out: MonthCheckpoint[] = [];
  let cumPurchaseSen = 0;
  let cumConsumedSen = 0;
  let cumNegativeUnits = 0;
  let closingSen = 0;
  let mi = 0;
  // Finalize every month-end strictly before `dateExclusive` (or all remaining
  // when null) using the running totals as they stand right now. Events dated
  // ON a month-end fall INTO that month (they are applied before the next, later
  // event triggers the flush), matching computeMaterialPeriod's date <= end.
  const flushBefore = (dateExclusive: string | null) => {
    while (mi < monthEnds.length && (dateExclusive === null || monthEnds[mi] < dateExclusive)) {
      out.push({ monthEnd: monthEnds[mi], closingSen, cumPurchaseSen, cumConsumedSen, cumNegativeUnits });
      mi++;
    }
  };
  replayFifo(m, (step) => {
    flushBefore(step.date);
    if (step.kind === "receipt") {
      cumPurchaseSen += step.valueSen;
    } else {
      cumConsumedSen += step.fifoCostSen;
      cumNegativeUnits += step.negativeUnits;
    }
    closingSen = step.queueValueAfter;
  });
  flushBefore(null);
  return out;
}

// Reconstruct one window's period figures from two cumulative snapshots:
//   end       = cumulative as-of monthEnd(endYm)
//   prevStart = cumulative as-of monthEnd(month before startYm), or null when the
//               window starts at/before the first checkpoint (nothing precedes it).
// Because each field is additive across items, this is correct at item OR group
// level — feed it summed-over-group cumulatives to get the group's window row.
export function windowFromCheckpoints(
  end: CheckpointCum,
  prevStart: CheckpointCum | null,
): { openingSen: number; purchaseSen: number; closingSen: number; consumedSen: number; negativeUnits: number } {
  const p = prevStart ?? { closingSen: 0, cumPurchaseSen: 0, cumConsumedSen: 0, cumNegativeUnits: 0 };
  return {
    openingSen: p.closingSen,
    purchaseSen: end.cumPurchaseSen - p.cumPurchaseSen,
    closingSen: end.closingSen,
    consumedSen: end.cumConsumedSen - p.cumConsumedSen,
    negativeUnits: end.cumNegativeUnits - p.cumNegativeUnits,
  };
}
