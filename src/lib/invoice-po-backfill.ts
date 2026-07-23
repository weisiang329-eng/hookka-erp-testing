// ---------------------------------------------------------------------------
// invoice-po-backfill.ts — pure matcher for the one-shot legacy repair of
// BUG-2026-07-17-001. Pre-fix invoices never stored the per-line
// production_order_id link, so their printouts reconstruct the customer PO by
// product|fabric|size guessing (first-one-wins → same-fabric lines collapse
// onto one PO; 77 invoices / ~179 lines mislabeled in the 2026-07-23 audit).
//
// The DO already knows the answer (delivery_order_items.productionOrderId per
// line). This matcher aligns an invoice's items to its DO's items STRICTLY:
//
//   • group both sides by product|fabric|size;
//   • every group's line count must MATCH exactly, else the whole invoice is
//     refused (consolidated/edited lines need human eyes — guessing is the
//     disease we're curing, we don't re-infect);
//   • already-linked invoice lines consume their exact DO line first (post-fix
//     rows are authoritative and never rewritten);
//   • remaining lines pair up within their group. Lines inside one group are
//     business-identical (same product, fabric, size) — only the PO label
//     differs — so any pairing that preserves the group's PO MULTISET is
//     equally correct, and the multiset is exactly what the repair restores.
//
// Output is assignments ONLY (invoiceItemId → productionOrderId). The caller
// writes that single column and nothing else — amounts, quantities, prices and
// statuses are untouchable by construction (owner directive 2026-07-23:
// 「切记不要动到金额」).
// ---------------------------------------------------------------------------

export type BackfillInvLine = {
  id: string;
  productCode: string | null;
  fabricCode: string | null;
  sizeLabel: string | null;
  productionOrderId: string | null;
};

export type BackfillDoLine = {
  productCode: string | null;
  fabricCode: string | null;
  sizeLabel: string | null;
  productionOrderId: string | null;
};

export type BackfillMatch =
  | {
      ok: true;
      assignments: { invoiceItemId: string; productionOrderId: string }[];
      /** unlinked invoice lines whose paired DO line has no productionOrderId */
      unlinkableLines: number;
    }
  | { ok: false; reason: string };

const keyOf = (l: { productCode: string | null; fabricCode: string | null; sizeLabel: string | null }): string =>
  `${(l.productCode ?? "").trim()}|${(l.fabricCode ?? "").trim()}|${(l.sizeLabel ?? "").trim()}`;

export function matchInvoiceLinesToDoLines(
  invLines: BackfillInvLine[],
  doLines: BackfillDoLine[],
): BackfillMatch {
  if (invLines.length !== doLines.length) {
    return { ok: false, reason: `line count differs (invoice ${invLines.length} vs DO ${doLines.length})` };
  }
  const invByKey = new Map<string, BackfillInvLine[]>();
  const doByKey = new Map<string, BackfillDoLine[]>();
  for (const l of invLines) { const k = keyOf(l); (invByKey.get(k) ?? invByKey.set(k, []).get(k)!).push(l); }
  for (const l of doLines) { const k = keyOf(l); (doByKey.get(k) ?? doByKey.set(k, []).get(k)!).push(l); }

  const assignments: { invoiceItemId: string; productionOrderId: string }[] = [];
  let unlinkableLines = 0;

  for (const [k, invGroup] of invByKey) {
    const doGroup = doByKey.get(k);
    if (!doGroup || doGroup.length !== invGroup.length) {
      return { ok: false, reason: `group "${k}" count differs (invoice ${invGroup.length} vs DO ${doGroup?.length ?? 0})` };
    }
    const remaining = [...doGroup];
    const unlinked: BackfillInvLine[] = [];
    // Pass 1 — already-linked invoice lines consume their exact DO twin.
    for (const inv of invGroup) {
      const linked = (inv.productionOrderId ?? "").trim();
      if (!linked) { unlinked.push(inv); continue; }
      const at = remaining.findIndex((d) => (d.productionOrderId ?? "").trim() === linked);
      if (at === -1) {
        return { ok: false, reason: `group "${k}" has a linked line (${linked}) with no matching DO line` };
      }
      remaining.splice(at, 1);
    }
    // Pass 2 — pair the unlinked lines with what's left, in order.
    for (let i = 0; i < unlinked.length; i++) {
      const po = (remaining[i]?.productionOrderId ?? "").trim();
      if (po) assignments.push({ invoiceItemId: unlinked[i].id, productionOrderId: po });
      else unlinkableLines++;
    }
  }
  // Any DO-side key missing on the invoice side is implied impossible here:
  // equal totals + every invoice group matched ⇒ the multisets are identical.
  return { ok: true, assignments, unlinkableLines };
}
