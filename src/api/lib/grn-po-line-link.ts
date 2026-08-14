// ---------------------------------------------------------------------------
// grn-po-line-link.ts — the per-line link from a GOODS RECEIPT line back to the
// PURCHASE-ORDER line it receives.
//
// BUG-2026-08-13-150. `three-way-match.ts` resolved that link with two guesses
// stacked on each other:
//
//     const headerPo  = pos.find((p) => p.id === grn.poId) ?? pos[0];
//     const ownerPoId = (gi.po_id ?? gi.poId ?? "").trim() || headerPo.id;
//     const poItem    = (itemsByPo.get(ownerPoId) ?? [])[gi.poItemIndex];
//     const poPrice   = poItem?.unitPriceSen ?? 0;
//
// and `poPrice` is one of the two numbers the match compares. The fallback is
// not an edge case, it is the path the multi-PO code exists for: `pos` is
// loaded from the LINE purchase orders, so on a receipt whose header order is
// not among them `pos.find(...)` misses and `pos[0]` is an ARBITRARY purchase
// order — `IN (...)` carries no ORDER BY. A receipt line with no `po_id` of its
// own was then priced against another order's line **at the same position**.
//
// Both halves fail silently and both fail in the expensive direction: a wrong
// `poPrice` can report `FULL_MATCH` on an overcharge, and `poPrice = 0` (index
// miss) invents a 100% variance that blocks a correct invoice.
//
// A WRONG MATCH IS WORSE THAN A MISSING ONE. A missing one says "cannot check";
// a wrong one says "checked, all fine". So this resolver COUNTS claimants and
// REFUSES — the same discipline `invoice-so-item-link.ts` applies to the
// invoice→sales-order link, and the deliberate opposite of `priceForItem`'s
// first-one-wins over the same kind of rows (do-value.ts:37-41 — for a PRICE
// LOOKUP any matching line's value will do; for IDENTITY it will not).
//
// THE THREE TIERS
// ---------------
//   id          — `grn_items.po_item_id` names the PO line. Unambiguous by
//                 construction; this is what `grn.ts` has written since
//                 2026-08-04 and what the stock draw-down already acts on.
//   positional  — no line id (a legacy receipt), but the OWNING order is not in
//                 doubt: either the line records its own `po_id`, or the whole
//                 receipt draws on exactly ONE order. Being the only candidate
//                 is an observation, not a guess.
//   unresolved  — anything else. `poItemId: null` plus the reason.
//
// WHAT IS DELIBERATELY *NOT* HERE
// -------------------------------
//   • No `?? pos[0]`. A line that records no `po_id` on a receipt spanning two
//     or more orders is CONTESTED, and a contested line does not become
//     decidable by picking whichever row the database handed back first.
//   • No positional fall-through when an explicit `po_item_id` was recorded but
//     is not on any loaded order. The receipt already answered the question;
//     that the answer does not resolve is a data fault to REPORT, not to
//     paper over with a vaguer question (the same trap `resolveSoItemId`
//     refuses at invoice-so-item-link.ts:261-264).
//
// ORDERING — the third defect, and the quiet one
// ----------------------------------------------
// `poItemIndex` is a position, and a position only means something against a
// stated order. `purchase-orders.ts` states it once:
//
//     export const PO_ITEMS_ORDER = "ORDER BY line_no NULLS LAST, id";
//
// `line_no` is written from the request's array index on POST/PUT, so it is the
// PAPER order and it diverges from `id` order the first time a PO's lines are
// reordered. `grn.ts:930` reads the index against `PO_ITEMS_ORDER`;
// `three-way-match.ts` read it against a plain `ORDER BY id`. The same GRN line
// could therefore draw stock from one PO line and be PRICED against a different
// one, on a single-PO receipt, with nothing logged. Callers of this module must
// order with `PO_ITEMS_ORDER`; `buildPoLineIndex` preserves the order it is
// given and does not re-sort, so the caller's ORDER BY is the contract.
// ---------------------------------------------------------------------------

/** The columns this resolver reads off a `grn_items` row, dual-keyed. */
export type GrnLineRef = {
  poItemIndex?: number | null;
  po_id?: string | null;
  poId?: string | null;
  po_item_id?: string | null;
  poItemId?: string | null;
};

/** The columns this resolver reads off a `purchase_order_items` row. */
export type PoLineRef = {
  id: string;
  purchaseOrderId: string;
};

export type GrnPoLineOutcome =
  /** `po_item_id` names the line and that line was loaded — exact */
  | "id"
  /** no line id, but the owning order is unambiguous and the index is in range */
  | "positional"
  /** `po_item_id` is recorded but no loaded order carries it — REFUSED */
  | "unknown-line"
  /** the line names no order and the receipt spans two or more — REFUSED */
  | "contested-po"
  /** the owning order is known, but the row carries no position at all */
  | "index-missing"
  /** the owning order is known and the position is past the end of its lines */
  | "index-out-of-range"
  /** the receipt draws on no order at all */
  | "no-po"
  /**
   * A match row PERSISTED before this resolver existed. `resolveGrnPoLine`
   * never returns it — readers stamp it on rows whose `items` JSON carries no
   * `resolution` at all. Such a row was scored by the old guess and cannot now
   * be told apart from a resolved one, so it is reported as unknown rather than
   * relabelled `id`, which would be the same lie one layer up.
   */
  | "legacy-unknown";

export type GrnPoLineResult = {
  /** the PO line this receipt line receives, or NULL when it cannot be resolved */
  poItemId: string | null;
  /** the order that line belongs to, or NULL */
  poId: string | null;
  outcome: GrnPoLineOutcome;
};

/** Every outcome that resolved to exactly one PO line. */
export function isResolvedGrnPoLine(o: GrnPoLineOutcome): boolean {
  return o === "id" || o === "positional";
}

export type PoLineIndex = {
  /** PO line id → the line. */
  byId: Map<string, PoLineRef>;
  /** order id → its lines, IN THE ORDER THE CALLER SUPPLIED THEM. */
  byPo: Map<string, PoLineRef[]>;
  /** every order in scope for this receipt. */
  poIds: string[];
};

/**
 * Index the purchase-order lines a receipt could possibly draw on. PURE — takes
 * rows, returns maps, touches no DB, so the refusal rule can be tested directly
 * against adversarial fixtures.
 *
 * ⚠ `poItems` MUST already be ordered by `PO_ITEMS_ORDER`; see the header.
 */
export function buildPoLineIndex(
  poItems: readonly PoLineRef[],
  poIds: readonly string[],
): PoLineIndex {
  const byId = new Map<string, PoLineRef>();
  const byPo = new Map<string, PoLineRef[]>();
  for (const it of poItems) {
    const id = String(it.id ?? "");
    const owner = String(it.purchaseOrderId ?? "");
    if (!id || !owner) continue;
    byId.set(id, it);
    const arr = byPo.get(owner);
    if (arr) arr.push(it);
    else byPo.set(owner, [it]);
  }
  return { byId, byPo, poIds: [...new Set(poIds.filter(Boolean))] };
}

/** Read `grn_items.po_id` dual-keyed — snake_case in the schema, but a driver or view may camelCase it. */
export function grnLinePoId(line: GrnLineRef): string {
  return (line.po_id ?? line.poId ?? "").trim();
}

/** Read `grn_items.po_item_id` dual-keyed, same reason. */
export function grnLinePoItemId(line: GrnLineRef): string {
  return (line.po_item_id ?? line.poItemId ?? "").trim();
}

/**
 * Resolve ONE goods-receipt line to the purchase-order line it receives. PURE.
 *
 * Returns `poItemId: null` for every outcome `isResolvedGrnPoLine` rejects.
 * There is deliberately no "best effort" branch — see the header.
 */
export function resolveGrnPoLine(
  idx: PoLineIndex,
  line: GrnLineRef,
): GrnPoLineResult {
  // Tier 1 — the receipt recorded the line it received.
  const explicit = grnLinePoItemId(line);
  if (explicit) {
    const hit = idx.byId.get(explicit);
    if (hit) {
      return {
        poItemId: hit.id,
        poId: String(hit.purchaseOrderId),
        outcome: "id",
      };
    }
    // It named one and it is not here. Do NOT fall through to the position: the
    // receipt has already answered, and answering again more vaguely is how a
    // wrong link gets written with a clear conscience.
    return { poItemId: null, poId: grnLinePoId(line) || null, outcome: "unknown-line" };
  }

  // Tier 2 — no line id (legacy receipt). Which ORDER is this line's?
  if (idx.poIds.length === 0) {
    return { poItemId: null, poId: null, outcome: "no-po" };
  }
  const own = grnLinePoId(line);
  let ownerPoId: string;
  if (own) {
    ownerPoId = own;
  } else if (idx.poIds.length === 1) {
    // Exactly one claimant. Being the ONLY candidate is an observation.
    ownerPoId = idx.poIds[0];
  } else {
    // Two or more orders and the line names none of them. REFUSE.
    return { poItemId: null, poId: null, outcome: "contested-po" };
  }

  const i = line.poItemIndex;
  if (i === null || i === undefined || !Number.isInteger(i) || i < 0) {
    return { poItemId: null, poId: ownerPoId, outcome: "index-missing" };
  }
  const lines = idx.byPo.get(ownerPoId) ?? [];
  const hit = lines[i];
  if (!hit) {
    return { poItemId: null, poId: ownerPoId, outcome: "index-out-of-range" };
  }
  return {
    poItemId: hit.id,
    poId: String(hit.purchaseOrderId),
    outcome: "positional",
  };
}
