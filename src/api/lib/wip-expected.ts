// ---------------------------------------------------------------------------
// wip-expected.ts — ONE structural model of what `wip_items.stock_qty` SHOULD
// be, derived from the job-card history alone.
//
// `wip_items` is a code-keyed running balance that the cascade mutates with
// unscoped `WHERE code = ?` statements. Nothing ever re-derives it, so every
// missed decrement is permanent. This module is the missing derivation, and it
// has exactly two consumers so they can never disagree:
//
//   1. `applyWipInventoryChange` (production-orders/_helpers.ts) — when a PO's
//      LAST stage completes it drains the upstream rows this PO left standing.
//   2. `GET /api/inventory/wip/reconcile` (inventory-wip.ts) — read-only; lists
//      every stored row that disagrees with the derivation.
//
// THE MODEL (physical, not a mirror of the cascade's arithmetic):
//   A stage's output sits on a shelf iff
//     (a) the stage is finished (COMPLETED / TRANSFERRED), AND
//     (b) the next stage has not picked it up (its downstream is not active), AND
//     (c) the order has not left WIP altogether (the PO's LAST stage is done —
//         at that point the goods are FG / shipped, per the Plan B rule of
//         BUG-2026-04-30-003).
//   Quantity carried = the card's own `wipQty` (fallback: the PO quantity, then 1).
//   By construction the model never produces a negative: it only ever counts
//   work that was actually reported as finished.
//
// NO DEPARTMENT ORDERING IS HARDCODED. "Last stage", "upstream" and "downstream"
// are read off the job cards' own (wipKey, branchKey, sequence) structure, so a
// department added to the BOM tomorrow is drained like every other stage instead
// of silently accruing forever. The only department NAME in here is PACKING,
// and only to say it takes no part in the inventory cascade at all
// (BUG-2026-04-27-016 — it is a metadata-only step that records a rack number).
// ---------------------------------------------------------------------------
import { isHeadboardOnlySpecial } from "../routes/fg-units";

/** Departments that write no `wip_items` rows at all (BUG-2026-04-27-016). */
export const NON_CASCADE_DEPARTMENTS = new Set(["PACKING"]);

export type WipJobCardLike = {
  id: string;
  productionOrderId: string;
  departmentCode?: string | null;
  sequence?: number | null;
  status?: string | null;
  wipKey?: string | null;
  wipLabel?: string | null;
  wipQty?: number | null;
  branchKey?: string | null;
  wipType?: string | null;
};

export type WipProductionOrderLike = {
  id: string;
  quantity?: number | null;
  itemCategory?: string | null;
  specialOrder?: string | null;
};

const dept = (j: WipJobCardLike): string =>
  (j.departmentCode || "").toUpperCase();
const seq = (j: WipJobCardLike): number => Number(j.sequence ?? 0);

export const isWipDone = (status: string | null | undefined): boolean =>
  status === "COMPLETED" || status === "TRANSFERRED";

/**
 * A stage has "taken" its upstream once it starts, not only once it finishes.
 *
 * PAUSED counts (added 2026-09-06). Pausing does not put the material back on
 * the upstream shelf — the work is on the bench, stopped. This is also the ONE
 * definition the cascade in `production-orders/_helpers.ts` imports, so the
 * writer and this derivation cannot disagree about what "started" means; when
 * they disagreed, every reconcile report showed drift the cascade would never
 * produce. No card was PAUSED when this changed (measured: 0 of 45,511), so no
 * expected balance moved on the day.
 */
export const isWipActive = (status: string | null | undefined): boolean =>
  status === "IN_PROGRESS" || status === "PAUSED" || isWipDone(status);

export function wipCardQty(
  card: WipJobCardLike,
  po: WipProductionOrderLike | null | undefined,
): number {
  return Number(card.wipQty || po?.quantity || 1);
}

// ---------------------------------------------------------------------------
// HB-only bedframes: the DIVAN half of the BOM is never worked, so its job
// cards must not hold the "is the order finished?" gate open, and its rows are
// left alone rather than drained. Single definition — `_helpers.ts` re-exports
// this one rather than keeping a second copy.
// ---------------------------------------------------------------------------
export function filterJcsForCompletionGate<
  J extends { wipType?: string | null },
>(
  po:
    | { itemCategory?: string | null; specialOrder?: string | null }
    | null
    | undefined,
  jcs: J[],
): J[] {
  if (!po) return jcs;
  const isBf = (po.itemCategory ?? "").toUpperCase() === "BEDFRAME";
  if (!isBf) return jcs;
  if (!isHeadboardOnlySpecial(po.specialOrder ?? null)) return jcs;
  return jcs.filter((j) => (j.wipType ?? "").toUpperCase() !== "DIVAN");
}

/** The PO's job cards that actually take part in the `wip_items` cascade. */
export function wipCascadeCards(
  po: WipProductionOrderLike,
  allJcRows: WipJobCardLike[],
): WipJobCardLike[] {
  return allJcRows.filter(
    (j) =>
      j.productionOrderId === po.id &&
      !!(j.wipLabel || "").trim() &&
      !NON_CASCADE_DEPARTMENTS.has(dept(j)),
  );
}

/**
 * The PO's LAST stage — structural, never a department name.
 *
 * Cards are grouped into chains by `wipKey` (one chain per top-level WIP
 * component: DIVAN, HEADBOARD, SOFA_BASE …). The last stage of a chain is its
 * highest-`sequence` card; the PO's last stage is the union across chains.
 *
 * Single-card chains are FEEDERS, not products — the Option-C merged FAB_CUT
 * card carries its own one-card `wipKey` (`{poId}::{base}::{fabric}::FAB_CUT`)
 * and feeds the piece chains. Counting it as a terminal would hold the gate
 * open on a PO whose pieces are all finished. When every chain is a single card
 * there is nothing to feed, so they all count.
 */
export function wipTerminalCards(
  po: WipProductionOrderLike,
  allJcRows: WipJobCardLike[],
): WipJobCardLike[] {
  const cards = wipCascadeCards(po, allJcRows);
  if (cards.length === 0) return [];
  const chains = new Map<string, WipJobCardLike[]>();
  for (const c of cards) {
    // A null wipKey cannot be grouped with anything — give it its own chain.
    const key = c.wipKey ? `k:${c.wipKey}` : `id:${c.id}`;
    const bucket = chains.get(key);
    if (bucket) bucket.push(c);
    else chains.set(key, [c]);
  }
  const all = [...chains.values()];
  const product = all.filter((ch) => ch.length > 1);
  const pool = product.length > 0 ? product : all;
  const out: WipJobCardLike[] = [];
  for (const chain of pool) {
    const mx = Math.max(...chain.map(seq));
    for (const c of chain) if (seq(c) === mx) out.push(c);
  }
  return filterJcsForCompletionGate(po, out);
}

/**
 * Has the PO's last stage finished — i.e. have the goods left WIP entirely?
 * This is the generalisation of the old "every UPHOLSTERY job card is
 * COMPLETED" gate: identical on every PO that has an UPHOLSTERY stage, and
 * finally true (instead of never) on the POs whose BOM ends somewhere else.
 */
export function isWipTerminalDone(
  po: WipProductionOrderLike,
  allJcRows: WipJobCardLike[],
): boolean {
  const terminals = wipTerminalCards(po, allJcRows);
  return terminals.length > 0 && terminals.every((t) => isWipDone(t.status));
}

/**
 * The stage that consumes `card`'s output, if any.
 *
 * Resolution order, all read off the job cards themselves:
 *   1. the next card up in the SAME (wipKey, branchKey) — the branch's own chain;
 *   2. failing that (this card IS its branch's last stage), the LAST stage of
 *      its `wipKey` chain — parallel BOM branches run independently and
 *      converge only at the chain's terminal, which is exactly the set the
 *      cascade's own branch-terminal consume decrements. Resolving to "the next
 *      card by sequence" instead would name a card in a PARALLEL branch that
 *      never touches this one, and the drain would then double-decrement what
 *      the terminal consume already took.
 *   3. failing that (a feeder chain such as the merged FAB_CUT, whose whole
 *      chain is one card), the PO's next stage by sequence in any other chain —
 *      physically, the moment anyone starts on the set the cut stack has left
 *      the shelf.
 * Ties at the same sequence are all returned: any one of them starting counts.
 */
export function wipDownstreamCards(
  card: WipJobCardLike,
  cascadeCards: WipJobCardLike[],
): WipJobCardLike[] {
  const above = (pool: WipJobCardLike[]): WipJobCardLike[] => {
    const higher = pool.filter((c) => c.id !== card.id && seq(c) > seq(card));
    if (higher.length === 0) return [];
    const mn = Math.min(...higher.map(seq));
    return higher.filter((c) => seq(c) === mn);
  };
  const sameKey = cascadeCards.filter((c) => c.wipKey === card.wipKey);
  const sameBranch = above(
    sameKey.filter((c) => (c.branchKey ?? "") === (card.branchKey ?? "")),
  );
  if (sameBranch.length > 0) return sameBranch;
  if (sameKey.length > 1) {
    const mx = Math.max(...sameKey.map(seq));
    if (mx > seq(card)) return sameKey.filter((c) => seq(c) === mx);
  }
  return above(cascadeCards.filter((c) => c.wipKey !== card.wipKey));
}

export type WipContribution = { card: WipJobCardLike; label: string; qty: number };

/**
 * What this PO SHOULD still be holding in `wip_items`, per label.
 *
 * `assumeTerminalDone` defaults to reading the PO's real state. Pass `false` to
 * ask "what would this PO be holding if it had not just finished?" — which is
 * exactly the set the last stage has to drain.
 */
export function poWipStanding(
  po: WipProductionOrderLike,
  allJcRows: WipJobCardLike[],
  opts: { ignoreTerminalDone?: boolean } = {},
): WipContribution[] {
  const cards = wipCascadeCards(po, allJcRows);
  if (cards.length === 0) return [];
  if (!opts.ignoreTerminalDone && isWipTerminalDone(po, allJcRows)) return [];
  const out: WipContribution[] = [];
  for (const c of cards) {
    if (!isWipDone(c.status)) continue;
    const downstream = wipDownstreamCards(c, cards);
    if (downstream.some((d) => isWipActive(d.status))) continue;
    out.push({ card: c, label: (c.wipLabel || "").trim(), qty: wipCardQty(c, po) });
  }
  return out;
}

/**
 * FIX A — the rows a finishing PO leaves behind.
 *
 * Everything this PO put into `wip_items` that no downstream stage ever took
 * out, excluding the last stage's own rows (those are already handled by the
 * Plan B subtract in `applyWipInventoryChange`, and subtracting them here too
 * would double-decrement). Cards the completion gate drops (an HB-only
 * bedframe's DIVAN half) are left alone: their stages never ran, so their rows
 * are somebody else's stock, not this order's residue.
 */
export function poOrphanedUpstream(
  po: WipProductionOrderLike,
  allJcRows: WipJobCardLike[],
): WipContribution[] {
  const terminalIds = new Set(wipTerminalCards(po, allJcRows).map((t) => t.id));
  const gateKept = new Set(
    filterJcsForCompletionGate(po, wipCascadeCards(po, allJcRows)).map(
      (c) => c.id,
    ),
  );
  return poWipStanding(po, allJcRows, { ignoreTerminalDone: true }).filter(
    (c) => !terminalIds.has(c.card.id) && gateKept.has(c.card.id),
  );
}

/** The whole ledger, derived: code → the balance the job cards justify. */
export function expectedWipByCode(
  pos: WipProductionOrderLike[],
  allJcRows: WipJobCardLike[],
): Map<string, number> {
  const byPo = new Map<string, WipJobCardLike[]>();
  for (const j of allJcRows) {
    const bucket = byPo.get(j.productionOrderId);
    if (bucket) bucket.push(j);
    else byPo.set(j.productionOrderId, [j]);
  }
  const out = new Map<string, number>();
  for (const po of pos) {
    for (const c of poWipStanding(po, byPo.get(po.id) ?? [])) {
      if (!c.label) continue;
      out.set(c.label, (out.get(c.label) ?? 0) + c.qty);
    }
  }
  return out;
}

export type WipReconcileRow = {
  code: string;
  storedQty: number;
  expectedQty: number;
  diff: number;
};

export type WipReconcileResult = {
  checked: number;
  agreeing: number;
  disagreeing: number;
  netDiff: number;
  overstatedUnits: number;
  understatedUnits: number;
  negativeStoredRows: number;
  rows: WipReconcileRow[];
};

/**
 * Read-only reconciliation. Compares every stored row AND every code the job
 * cards justify (a code with stock the ledger has no row for is a disagreement
 * too) and reports the ones that differ. `diff = stored - expected`: positive
 * means the ledger is carrying stock the floor never reported.
 */
export function reconcileWip(
  pos: WipProductionOrderLike[],
  allJcRows: WipJobCardLike[],
  stored: { code: string; stockQty: number }[],
): WipReconcileResult {
  const expected = expectedWipByCode(pos, allJcRows);
  const storedByCode = new Map<string, number>();
  for (const s of stored) {
    const code = (s.code || "").trim();
    if (!code) continue;
    storedByCode.set(code, (storedByCode.get(code) ?? 0) + Number(s.stockQty || 0));
  }
  const codes = new Set<string>([...storedByCode.keys(), ...expected.keys()]);
  const rows: WipReconcileRow[] = [];
  let agreeing = 0;
  let negativeStoredRows = 0;
  for (const code of codes) {
    const storedQty = storedByCode.get(code) ?? 0;
    const expectedQty = expected.get(code) ?? 0;
    if (storedQty < 0) negativeStoredRows += 1;
    const diff = storedQty - expectedQty;
    if (diff === 0) {
      agreeing += 1;
      continue;
    }
    rows.push({ code, storedQty, expectedQty, diff });
  }
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.code.localeCompare(b.code));
  return {
    checked: codes.size,
    agreeing,
    disagreeing: rows.length,
    netDiff: rows.reduce((n, r) => n + r.diff, 0),
    overstatedUnits: rows.reduce((n, r) => n + (r.diff > 0 ? r.diff : 0), 0),
    understatedUnits: rows.reduce((n, r) => n + (r.diff < 0 ? -r.diff : 0), 0),
    negativeStoredRows,
    rows,
  };
}
