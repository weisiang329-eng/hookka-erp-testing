// ---------------------------------------------------------------------------
// invoice-line-price — THE rule for an invoice line's price, and the ONE place
// it is expressed. Pure, dependency-free, importable by BOTH sides
// (`src/api/lib/` is backend-only; this is not).
//
// ## The rule (write it down before you change anything below)
//
// 1. **The charge is `invoice_items.unitPriceSen`, and it is authoritative.**
//    It is what the customer is billed, what every total is derived from, and
//    what an already-issued document has told the customer. Nothing on a read
//    path may recompute it, and nothing may display a different number as "the
//    unit price".
//
// 2. **The build-up (Base / Divan / Leg / T.Height / Special) is an
//    EXPLANATION of that charge, never a second source of it.** It is resolved
//    per line by `src/api/lib/invoice-print-extras.ts` (the line's own sales
//    order, via `production_order_id`), or, once a line has been edited
//    (`priceEdited = 1`), read straight off the invoice's own columns.
//
// 3. **An explanation that does not add up is not an explanation.** A build-up
//    is shown ONLY when `base + divan + leg + totalHeight + special ===
//    unitPriceSen`. Otherwise the line renders as a single price. Showing
//    nothing is honest; showing a decomposition that contradicts the charge
//    ("Base 0 … = RM 305") is not. Same rule on screen, in the PDF and in the
//    e-mailed copy — that is the whole point of this file.
//
// 4. **A build-up with no surcharge explains nothing** — Base *is* the charge —
//    so it also renders as a single price.
//
// 5. **Editing edits the explanation and the charge TOGETHER.** The operator
//    types components; the new charge is their sum (`invoiceLineUnitSen`, the
//    same sum the backend `priceEdits` handler writes). There is therefore no
//    path that moves one without the other — and, critically, **opening the
//    editor and pressing Save without typing anything must leave the charge
//    exactly as it was.** That makes the SEED part of the rule, not a UI
//    detail: a seed is only ever a build-up that already reconciles to the
//    charge (`invoicePriceEditSeed`). When the components are unknown or
//    contradict the charge, the seed is the charge itself as Base with the four
//    surcharges at 0 — reconciling by construction, and (by rule 4) never
//    re-displayed as a fake decomposition.
//
// 6. **Never retro-price.** These are read/seed helpers only. Nothing here
//    writes, and no read path may "correct" a stored document's price.
//
// ## Why it lives here
//
// This started as the ONE definition of the sum, because the invoice price
// editor computed `base+divan+leg+special+totalHeight` in FOUR places and one
// of them — the save — included totalHeight while the three previews did not:
// opening the editor showed a price ~RM3 lower than the real one, and Save
// wrote the on-screen (lower) number over the correct stored price.
//
// The same disease then reappeared one level up: the *build-up* was derived in
// the backend resolver, in the invoice detail read view, in its edit seed and
// in the PDF builder, and only the PDF carried rule 3. So the screen printed a
// build-up the PDF would have refused, and pressing Edit → Save with no typing
// silently repriced the line. Everything now goes through this file.
// ---------------------------------------------------------------------------

/** The five price components of an invoice line, in integer sen. */
export type InvoiceLinePriceParts = {
  baseSen: number;
  divanSen: number;
  legSen: number;
  specialSen: number;
  totalHeightSen: number;
};

/**
 * The same five components as they arrive from the wire / DB — any of them may
 * be absent or null on a legacy row.
 */
export type InvoicePriceComponents = {
  baseSen?: number | null;
  divanSen?: number | null;
  legSen?: number | null;
  specialSen?: number | null;
  totalHeightSen?: number | null;
};

const n = (v: unknown): number => Number(v) || 0;

/** Unit price in sen = base + divan + leg + special + totalHeight. */
export function invoiceLineUnitSen(p: InvoicePriceComponents): number {
  return (
    n(p.baseSen) + n(p.divanSen) + n(p.legSen) + n(p.specialSen) + n(p.totalHeightSen)
  );
}

/** The separately-priced add-ons only (rule 4: no surcharge → nothing to explain). */
export function invoiceSurchargeSen(ex: InvoicePriceComponents | null | undefined): number {
  if (!ex) return 0;
  return n(ex.divanSen) + n(ex.legSen) + n(ex.specialSen) + n(ex.totalHeightSen);
}

/**
 * Rule 3. True when the components add up to the charged unit price — the only
 * condition under which a build-up may be displayed, printed or seeded.
 */
export function invoiceBuildUpReconciles(
  ex: InvoicePriceComponents | null | undefined,
  chargedSen: number,
): boolean {
  if (!ex) return false;
  return invoiceLineUnitSen(ex) === (Number(chargedSen) || 0);
}

export type InvoicePriceRow = { label: string; sen: number };

/**
 * The invoice Price-column build-up: Base + each non-zero surcharge + "=" unit.
 *
 * Returns `undefined` — meaning "render the single charged price" — when there
 * is no build-up at all (rule 2), no surcharge (rule 4), or the components do
 * not reconcile to the charge (rule 3).
 *
 * The `=` row always carries `chargedSen`, never a recomputed sum: the charge
 * is authoritative (rule 1).
 */
export function invoicePriceBuildUp(
  ex: InvoicePriceComponents | null | undefined,
  chargedSen: number,
): InvoicePriceRow[] | undefined {
  if (!ex) return undefined;
  const charge = Number(chargedSen) || 0;
  const base = n(ex.baseSen);
  const divan = n(ex.divanSen);
  const leg = n(ex.legSen);
  const th = n(ex.totalHeightSen);
  const special = n(ex.specialSen);
  if (!(divan || leg || th || special)) return undefined;
  if (base + divan + leg + th + special !== charge) return undefined;
  const rows: InvoicePriceRow[] = [{ label: "Base", sen: base }];
  if (divan) rows.push({ label: "+ Divan", sen: divan });
  if (leg) rows.push({ label: "+ Leg", sen: leg });
  if (th) rows.push({ label: "+ T.Height", sen: th });
  if (special) rows.push({ label: "+ Special", sen: special });
  rows.push({ label: "=", sen: charge });
  return rows;
}

export type InvoicePriceEditSeed = InvoiceLinePriceParts & {
  /**
   * true  — the resolved build-up reconciled and was used verbatim.
   * false — it did not (or there was none), so the charge was seeded as Base.
   *         Callers surface this so the operator knows the components on file
   *         could not be trusted, rather than believing the zeros.
   */
  resolved: boolean;
};

/**
 * Rule 5. The five fields the price editor opens with, guaranteed to sum to
 * `chargedSen` so that a Save with nothing typed re-writes the SAME unit price.
 *
 * A resolved build-up is used verbatim when it reconciles. When it does not —
 * no PO link, a legacy row, combo-redistributed sofa base — the components are
 * not known, and inventing a decomposition would be a lie the operator would
 * then sign. We seed the one thing we do know: the charge, as Base. By rule 4
 * that is never re-rendered as a decomposition, so nothing false reaches the
 * customer's document either.
 */
export function invoicePriceEditSeed(
  ex: InvoicePriceComponents | null | undefined,
  chargedSen: number,
): InvoicePriceEditSeed {
  const charge = Math.max(0, Number(chargedSen) || 0);
  if (invoiceBuildUpReconciles(ex, charge) && ex) {
    return {
      baseSen: n(ex.baseSen),
      divanSen: n(ex.divanSen),
      legSen: n(ex.legSen),
      specialSen: n(ex.specialSen),
      totalHeightSen: n(ex.totalHeightSen),
      resolved: true,
    };
  }
  return {
    baseSen: charge,
    divanSen: 0,
    legSen: 0,
    specialSen: 0,
    totalHeightSen: 0,
    resolved: false,
  };
}
