// ---------------------------------------------------------------------------
// invoice-price-edit-payload — decide WHICH invoice lines a Save writes, and
// with what values.
//
// WHY THIS IS ITS OWN FILE
// This rule decides whether a customer gets billed. It used to live inside
// `src/pages/invoices/detail.tsx`, a ~1,100-line component, where the only way
// to check it was to read it. On 2026-08-20 it wrote RM 0 into 112 lines across
// 17 SENT invoices — three of them reduced to a RM 0 total — and nothing in the
// system objected. See BUG-2026-08-20-158.
//
// THE FAULT, because the shape recurs
// The invoice detail is served stale-while-revalidate from localStorage, so
// `invoice.items` can GAIN rows after the price editor opened and seeded itself.
// Such a row has neither a draft nor a seed, and both fallbacks pointed the
// wrong way:
//
//     const now = priceDraft[id] || ZERO;   // no draft -> the value is ZERO
//     if (!was) return true;                // no seed  -> "the operator edited it"
//
// Read together they say: "the operator set this line to zero — write it."
// Two independent absences combined into a confident, wrong, money-changing
// assertion. And the table hid it: a row with no draft falls back to displaying
// the STORED price, so the editor looked perfectly normal.
//
// THE RULE
//   no draft            -> we know nothing about this line. NEVER write it.
//   draft, no seed      -> the operator typed into a line that had no baseline.
//                          That is a real edit.
//   draft and seed      -> write it only if something actually differs.
//
// An absent value is not a value. Skipping is always safe: a line nobody typed
// into keeps exactly what it already charges.
// ---------------------------------------------------------------------------

/** One line's five price components, as the RM strings the inputs hold. */
export type PriceComponents = {
  base: string;
  divan: string;
  leg: string;
  special: string;
  totalHeight: string;
};

export type PriceEditPayloadLine = {
  id: string;
  baseSen: number;
  divanSen: number;
  legSen: number;
  specialSen: number;
  totalHeightSen: number;
  discountSen: number;
  /**
   * The operator really did type zero into every component, as opposed to the
   * client having no idea what this line costs. The backend refuses an implicit
   * zero on a line that currently charges something and needs this to accept a
   * deliberate one (a genuinely free line).
   */
  allowZero: boolean;
};

export type PriceEditInputs = {
  items: Array<{ id: string }>;
  priceDraft: Record<string, PriceComponents | undefined>;
  priceSeed: Record<string, PriceComponents | undefined>;
  discountDraft: Record<string, number | undefined>;
  discountSeed: Record<string, number | undefined>;
};

/** RM string -> whole sen, clamped at 0. Mirrors the component's own `sen`. */
export function rmToSen(s: string): number {
  return Math.max(0, Math.round((Number(s) || 0) * 100));
}

/**
 * Has this line actually been edited? See the rule in this file's header.
 * A line with no draft is NOT edited — it is unknown, which is not the same
 * thing and must never be written.
 */
export function isLineEdited(id: string, inp: PriceEditInputs): boolean {
  const now = inp.priceDraft[id];
  const was = inp.priceSeed[id];
  if (!now) return false;
  if (!was) return true;
  if ((inp.discountDraft[id] ?? 0) !== (inp.discountSeed[id] ?? 0)) return true;
  return (
    rmToSen(now.base) !== rmToSen(was.base) ||
    rmToSen(now.divan) !== rmToSen(was.divan) ||
    rmToSen(now.leg) !== rmToSen(was.leg) ||
    rmToSen(now.special) !== rmToSen(was.special) ||
    rmToSen(now.totalHeight) !== rmToSen(was.totalHeight)
  );
}

/** Build the `priceEdits` array a Save posts. Only genuinely edited lines. */
export function buildPriceEditPayload(inp: PriceEditInputs): PriceEditPayloadLine[] {
  const out: PriceEditPayloadLine[] = [];
  for (const it of inp.items) {
    if (!isLineEdited(it.id, inp)) continue;
    // isLineEdited already proved a draft exists.
    const d = inp.priceDraft[it.id] as PriceComponents;
    const baseSen = rmToSen(d.base);
    const divanSen = rmToSen(d.divan);
    const legSen = rmToSen(d.leg);
    const specialSen = rmToSen(d.special);
    const totalHeightSen = rmToSen(d.totalHeight);
    out.push({
      id: it.id,
      baseSen,
      divanSen,
      legSen,
      specialSen,
      totalHeightSen,
      discountSen: inp.discountDraft[it.id] ?? 0,
      allowZero: baseSen + divanSen + legSen + specialSen + totalHeightSen === 0,
    });
  }
  return out;
}
