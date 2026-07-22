// ---------------------------------------------------------------------------
// height-surcharge.ts — derive a line's divan / leg height surcharge from the
// saved height, for write paths that don't compute it themselves.
//
// WHY THIS EXISTS (RM 12,455 under-billed, found 2026-07-22):
// This is the THIRD time the same bug has been fixed one column at a time:
//
//   2026-07-14  totalHeightPriceSen  — recompute dropped a client-sent field
//   2026-07-17  specialOrderPriceSen — BUG-2026-07-17-002, RM 8,060 / 66 SOs
//   2026-07-22  divanPriceSen + legPriceSen  ← this file
//
// Each fix repaired only the component that had been noticed. The shape never
// changed: `sales_order_items.divanPriceSen` was whatever the client POSTed,
// and only ONE of the two clients computes it —
//   • src/pages/sales/create.tsx — the typed form. selectDivan / selectLeg look
//     the height up in the owner's price list and always send the number.
//   • src/components/scan-po-modal.tsx (+ m/ScanPOSheet) — the scan-a-customer-
//     PO paths. They POST /api/sales-orders directly with divanHeightInches /
//     legHeightInches and NO price, so `Number(item.divanPriceSen) || 0` stored
//     0. The operator can even change the height inside the scan modal and
//     still no price attaches.
//
// Measured on prod 2026-07-22, live non-service SO lines with a 10"/12" divan:
//   typed by hand : 104 charged / 43 not
//   scanned       :   0 charged / 105 not      ← every single one
// Legs the same (0 of 12 scanned lines charged). April 2026, before the scan
// flow took over, was 82 charged / 0 missed.
//
// Verified NOT a bookkeeping artifact, the same way the 07-17 fix was: for
// every product where an 8" line and a 10" line coexist on the same customer,
// basePriceSen is IDENTICAL (e.g. 1007-(Q) is RM 425 either way) — the height
// money is not hidden in the base price, it was simply never charged.
//
// TRUST MODEL — identical to special-order-surcharge.ts, deliberately narrow:
//   • client SENT a number (even 0) → TRUST IT, derive nothing. The typed form
//     always sends one, so a hand-discounted or waived height stands, and
//     Service-Order mode (which sends 0 on purpose) keeps charging 0.
//   • client OMITTED the field (undefined/null) → derive from the height.
//     Today that is exactly the two scan paths.
// An unknown height contributes 0 — never invent a price for something the
// owner's list doesn't carry ("reject, don't normalize").
//
// NOTE totalHeightPriceSen is NOT derivable here: no total-height column is
// stored on the line, so there is nothing for the server to look the price up
// from. It stays client-supplied (the 2026-07-14 fix trusts it verbatim).
// ---------------------------------------------------------------------------

/** One entry of kv_config.variants-config.divanHeights / .legHeights.
 *  `value` is the label the owner types — `10"`, `10 inch`, `No Leg`. */
export type CfgHeight = { value: string; priceSen: number };

/**
 * Inches out of a config label. Accepts `10`, `10"`, `10 inch`, `10in`,
 * `10.5"`. Returns null for a non-numeric label such as "No Leg" — those are
 * choices without a height, and they price at 0 like any unknown.
 */
export function parseHeightLabelInches(value: string | null | undefined): number | null {
  if (value == null) return null;
  const m = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Surcharge in sen for one height, from the owner's list. Mirrors selectDivan /
 * selectLeg in sales/create.tsx (same list, matched on the same label) so a
 * scanned order prices identically to a typed one. Unknown height → 0.
 */
export function deriveHeightSurchargeSen(
  heightInches: number | string | null | undefined,
  cfgHeights?: CfgHeight[] | null,
): number {
  if (heightInches == null || heightInches === "") return 0;
  const inches = Number(heightInches);
  if (!Number.isFinite(inches) || inches <= 0) return 0;
  if (!Array.isArray(cfgHeights)) return 0;
  for (const e of cfgHeights) {
    if (!e || typeof e !== "object") continue;
    if (parseHeightLabelInches(e.value) !== inches) continue;
    const p = Number(e.priceSen);
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

/**
 * The write-path decision for ONE height component. Returns the surcharge to
 * STORE. Trusts any client-supplied number (see TRUST MODEL above); derives
 * only when the field was omitted entirely.
 *
 * `isServiceOrder` short-circuits to 0: service orders are free by design (the
 * form sends an explicit 0, but a service path that omits the field must not
 * suddenly start billing repairs).
 */
export function resolveHeightPriceSen(
  sentValue: number | string | null | undefined,
  heightInches: number | string | null | undefined,
  cfgHeights?: CfgHeight[] | null,
  isServiceOrder?: boolean,
): number {
  if (sentValue !== undefined && sentValue !== null) {
    return Number(sentValue) || 0;
  }
  if (isServiceOrder) return 0;
  return deriveHeightSurchargeSen(heightInches, cfgHeights);
}
