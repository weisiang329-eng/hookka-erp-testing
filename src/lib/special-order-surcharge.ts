// ---------------------------------------------------------------------------
// special-order-surcharge.ts — derive a line's special-order surcharge from the
// saved `specialOrder` TEXT, for write paths that don't compute it themselves.
//
// WHY THIS EXISTS (BUG-2026-07-17-002 — RM 8,060 under-billed across 66 SOs):
// `sales_order_items.specialOrderPriceSen` was whatever the client POSTed.
// Two clients post sales orders and only ONE of them computes it:
//   • src/pages/sales/create.tsx  — the typed form. Computes the surcharge from
//     the selected CODES and always sends the number. Correct.
//   • src/components/scan-po-modal.tsx + src/pages/m/components/ScanPOSheet.tsx
//     — the scan-a-customer-PO paths. They POST /api/sales-orders DIRECTLY
//     (never through the form), sending the `specialOrder` TEXT and a
//     `basePriceSen` read off the customer's PDF, and NO specialOrderPriceSen.
//     The backend's `Number(item.specialOrderPriceSen) || 0` then stored 0.
// Net: the same bed with the same option was charged RM 80 when typed and RM 0
// when scanned. Measured on prod: 82 of 166 special-order lines charged 0.
//
// Verified NOT a bookkeeping artifact: for every product+fabric where a plain
// line and an optioned line coexist, basePriceSen is IDENTICAL — the customer's
// PO price does not silently include the option, so the money was really lost.
//
// This is the same bug class as the 2026-07-14 totalHeightPriceSen fix in
// sales-orders.ts (a surcharge component silently dropped from the stored unit
// price). The durable answer, per the FE+BE-unified-validation rule, is that the
// SERVER derives the surcharge when the client didn't supply one — so no future
// client can skip it by omission.
//
// TRUST MODEL — deliberately narrow, so this can't over-bill:
//   • client SENT a number (even 0) → TRUST IT, derive nothing. The typed form
//     always sends one, so its combined-cover maths and custom specials win, and
//     Service-Order mode (which sends 0 on purpose — SVs are free by default)
//     keeps charging 0.
//   • client OMITTED the field (undefined/null) → derive from the text.
//     Today that is exactly the two scan paths.
// An unknown token contributes 0 — never guess a price for something that isn't
// in the catalog ("reject, don't normalize"; don't invent money).
// ---------------------------------------------------------------------------
import { specialOrderOptions } from "./pricing-options";

/** Shape of one entry in kv_config.variants-config.specials (owner-editable). */
export type CfgSpecial = { value: string; priceSen: number };

/** Operator free-text special with its own surcharge ("OTHER: <desc>"). */
export type CustomSpecialInput = {
  description?: string | null;
  surchargeSen?: number | null;
};

// The two cover options have a combined cap: picking BOTH costs RM 100 flat,
// not 50 + 80 = 130. Source: pricing-options.ts:66 ("If HB & divan full cover
// combined = RM100 total") and calcPredefinedSurcharge in sales/create.tsx.
export const HB_FULL_COVER = "HB Fully Cover";
export const DIVAN_FULL_COVER = "Divan Full Cover";
export const HB_DIVAN_COMBINED_SEN = 10000;

/** Split the stored text into option tokens. The two writers disagree on the
 *  separator — the form joins with "; " while scan-po.ts:430 joins with ", " —
 *  so accept both. "OTHER: <desc>" tokens are custom specials and are priced
 *  from `customSpecials`, never from the catalog. */
export function parseSpecialOrderTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return String(text)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^OTHER\s*:/i.test(s));
}

/** Catalog price for one option NAME. Owner's kv_config override wins; the
 *  static table is the fallback. Unknown name → 0 (not a priced option). */
function priceOfSen(name: string, cfgSpecials?: CfgSpecial[] | null): number {
  const known = specialOrderOptions.find((o) => o.name === name);
  if (!known) return 0;
  if (Array.isArray(cfgSpecials)) {
    const hit = cfgSpecials.find(
      (e) => e && typeof e === "object" && e.value === name,
    );
    if (hit && Number.isFinite(Number(hit.priceSen))) return Number(hit.priceSen);
  }
  return known.surcharge;
}

/**
 * Total surcharge in sen for a line, derived from its saved text.
 * Mirrors calcPredefinedSurcharge + calcTotalSpecialSurcharge in
 * sales/create.tsx (same catalog, same config override, same combined-cover
 * rule) so a scanned order prices identically to a typed one.
 */
export function deriveSpecialOrderSurchargeSen(
  specialOrderText: string | null | undefined,
  customSpecials?: CustomSpecialInput[] | null,
  cfgSpecials?: CfgSpecial[] | null,
): number {
  const tokens = parseSpecialOrderTokens(specialOrderText);
  const hasHb = tokens.includes(HB_FULL_COVER);
  const hasDivan = tokens.includes(DIVAN_FULL_COVER);
  const combined = hasHb && hasDivan;

  let sen = 0;
  const counted = new Set<string>();
  for (const t of tokens) {
    if (combined && (t === HB_FULL_COVER || t === DIVAN_FULL_COVER)) continue;
    // A repeated token is the same option named twice — charge it once.
    if (counted.has(t)) continue;
    counted.add(t);
    sen += priceOfSen(t, cfgSpecials);
  }
  if (combined) sen += HB_DIVAN_COMBINED_SEN;

  for (const cs of customSpecials ?? []) {
    const v = Number(cs?.surchargeSen);
    if (Number.isFinite(v) && v > 0) sen += Math.round(v);
  }
  return sen;
}

/**
 * The write-path decision. Returns the surcharge to STORE for one posted item.
 * Trusts any client-supplied number (see TRUST MODEL above); only derives when
 * the field was omitted entirely.
 */
export function resolveSpecialOrderPriceSen(
  item: {
    specialOrderPriceSen?: number | string | null;
    specialOrder?: string | null;
    customSpecials?: CustomSpecialInput[] | null;
  },
  cfgSpecials?: CfgSpecial[] | null,
): number {
  if (item.specialOrderPriceSen !== undefined && item.specialOrderPriceSen !== null) {
    return Number(item.specialOrderPriceSen) || 0;
  }
  return deriveSpecialOrderSurchargeSen(
    item.specialOrder,
    item.customSpecials,
    cfgSpecials,
  );
}
