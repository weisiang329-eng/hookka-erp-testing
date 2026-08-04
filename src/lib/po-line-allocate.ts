// ---------------------------------------------------------------------------
// po-line-allocate.ts — decide which PO line each scanned line draws down.
//
// Owner 2026-08-04: "如果它的 PO 来自两个的话，它一定要来自首两张 PO 进一张 GR
// 的，这东西是串联的."
//
// A supplier bills or delivers against several of our purchase orders on one
// document — ADD WOOD prints "P/O No : 2607-003/2607-020" — and that is ONE
// receipt, not two. `po-ref-match.ts` already reads both references; until now
// the scan wizard refused to link either, because a card carried a single
// purchaseOrderId and linking one would have looked reconciled while the other
// order's goods were never drawn down.
//
// The storage side is no longer the constraint: `grn_items.po_id/po_item_id`
// and `purchase_invoice_items.po_id` record ownership per LINE. What was
// missing is the decision — given a scanned line and several candidate orders,
// which PO line is it? That is this module.
//
// The rule is deliberately unwilling to guess:
//
//   • a line matches PO lines by internal material code (the supplier's own
//     SKU is a fallback, since not every PO records one);
//   • an order still OUTSTANDING on that material wins over one already fully
//     received — a delivery arriving today is far more likely to be the open
//     order than the closed one;
//   • when two candidates remain equally plausible, it allocates NOTHING and
//     the operator chooses. A wrong allocation draws down the wrong purchase
//     order, which reconciles cleanly and is discovered only when the other
//     order is chased for goods that already arrived;
//   • a PO line is consumed once, so two scanned lines cannot both claim it.
//
// Pure — no React, no DB.
// ---------------------------------------------------------------------------

export interface AllocPoItem {
  id: string;
  materialCode?: string | null;
  materialName?: string | null;
  supplierSKU?: string | null;
  quantity?: number | null;
  receivedQty?: number | null;
}

export interface AllocPo {
  id: string;
  poNo?: string | null;
  items?: AllocPoItem[] | null;
}

export interface AllocLine {
  materialCode?: string | null;
  supplierSku?: string | null;
}

export interface Allocation {
  poId: string;
  poItemId: string;
  /** Position of the line on ITS OWN purchase order — the legacy fallback key. */
  poItemIndex: number;
  /** True when the chosen PO line still had quantity outstanding. */
  outstanding: boolean;
}

function norm(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function outstandingOf(it: AllocPoItem): number {
  return (Number(it.quantity) || 0) - (Number(it.receivedQty) || 0);
}

/**
 * Allocate each scanned line to a PO line across the orders the document named.
 *
 * Returns one entry per input line, `null` where no confident allocation
 * exists. Order is preserved so callers can zip it back onto their lines.
 */
export function allocateLinesToPos(
  lines: AllocLine[],
  pos: AllocPo[],
): Array<Allocation | null> {
  // Flatten once, remembering each line's owner and its position on that owner
  // — `poItemIndex` is a position into ITS OWN purchase order, never a global.
  const flat: Array<{ poId: string; item: AllocPoItem; index: number }> = [];
  for (const po of pos) {
    const items = Array.isArray(po.items) ? po.items : [];
    items.forEach((item, index) => flat.push({ poId: po.id, item, index }));
  }

  const taken = new Set<string>();
  return lines.map((line) => {
    const code = norm(line.materialCode);
    const sku = norm(line.supplierSku);
    if (!code && !sku) return null;

    const candidates = flat.filter((f) => {
      if (taken.has(f.item.id)) return false;
      if (code && norm(f.item.materialCode) === code) return true;
      // Only fall back to the supplier's own code when we have no internal one
      // — a matching internal code is the stronger statement of identity.
      if (!code && sku && norm(f.item.supplierSKU) === sku) return true;
      return false;
    });
    if (candidates.length === 0) return null;

    // An open order beats a closed one: goods arriving now are far more likely
    // to belong to the PO still waiting for them.
    const open = candidates.filter((f) => outstandingOf(f.item) > 0);
    const pool = open.length > 0 ? open : candidates;
    if (pool.length !== 1) return null; // genuinely ambiguous — a human decides

    const chosen = pool[0];
    taken.add(chosen.item.id);
    return {
      poId: chosen.poId,
      poItemId: chosen.item.id,
      poItemIndex: chosen.index,
      outstanding: outstandingOf(chosen.item) > 0,
    };
  });
}

/**
 * The PO to show as the document's header.
 *
 * Ownership lives on the lines; the header is display only. The first order
 * that actually received an allocation is the honest choice — falling back to
 * the first matched reference when nothing allocated, so the operator still
 * sees what the document named.
 */
export function headerPoId(
  allocations: Array<Allocation | null>,
  matchedPoIds: string[],
): string | null {
  for (const a of allocations) if (a) return a.poId;
  return matchedPoIds[0] ?? null;
}

/** Every PO that ended up owning at least one line. */
export function allocatedPoIds(allocations: Array<Allocation | null>): string[] {
  const out: string[] = [];
  for (const a of allocations) {
    if (a && !out.includes(a.poId)) out.push(a.poId);
  }
  return out;
}
