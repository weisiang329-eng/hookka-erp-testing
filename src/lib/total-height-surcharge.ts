// ---------------------------------------------------------------------------
// total-height-surcharge.ts — derive a bedframe line's TOTAL-HEIGHT surcharge
// from gap + divan + leg, for write paths that don't compute it themselves.
//
// WHY THIS EXISTS (the 4th instance of the same class — BUG-CLASSES.md C1):
//   2026-07-14  totalHeightPriceSen — recompute dropped a client-sent field
//   2026-07-17  specialOrderPriceSen
//   2026-07-22  divanPriceSen + legPriceSen
//   2026-07-23  totalHeightPriceSen, PROPERLY — a stored column + server fallback
//
// Total height = gap + divan + leg (src/pages/sales/create.tsx:1011). The
// owner's config prices specific totals (kv_config variants-config.totalHeights,
// e.g. 26"=RM 80, 28"=RM 160). The typed form computes it; the scan / import
// paths never sent it, and there was no stored column and no server fallback —
// so it landed in ZERO of 125 eligible lines on prod (RM 10,240 uncharged).
//
// TRUST MODEL — identical to height/special surcharge:
//   • client SENT a number (even 0) → trust it (the typed form's own maths,
//     a deliberate waiver, Service-Order mode's 0).
//   • client OMITTED it → derive from gap+divan+leg via the owner's config.
//   • total not in the config → 0. Never invent a price.
// ---------------------------------------------------------------------------
import type { CfgHeight } from "./height-surcharge";
import { parseHeightLabelInches } from "./height-surcharge";

/**
 * Surcharge in sen for a total height (gap+divan+leg inches), from the owner's
 * `variants-config.totalHeights` list. Mirrors calcTotalHeightSurcharge in
 * sales/create.tsx (same list, matched on the same `NN"` label). Unknown → 0.
 */
export function deriveTotalHeightSurchargeSen(
  totalInches: number | null | undefined,
  cfgTotalHeights?: CfgHeight[] | null,
): number {
  const total = Number(totalInches);
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Array.isArray(cfgTotalHeights)) return 0;
  for (const e of cfgTotalHeights) {
    if (!e || typeof e !== "object") continue;
    if (parseHeightLabelInches(e.value) !== total) continue;
    const p = Number(e.priceSen);
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

/** total height = gap + divan + leg (inches). Missing parts count as 0. */
export function totalHeightInches(
  gapInches: number | string | null | undefined,
  divanHeightInches: number | string | null | undefined,
  legHeightInches: number | string | null | undefined,
): number {
  return (Number(gapInches) || 0) + (Number(divanHeightInches) || 0) + (Number(legHeightInches) || 0);
}

/**
 * Write-path decision for the total-height component. Returns the surcharge to
 * STORE. Trusts any client-supplied number; derives only when the field was
 * omitted. Service orders short-circuit to 0 (variant pricing is suppressed).
 */
export function resolveTotalHeightPriceSen(
  sentValue: number | string | null | undefined,
  gapInches: number | string | null | undefined,
  divanHeightInches: number | string | null | undefined,
  legHeightInches: number | string | null | undefined,
  cfgTotalHeights?: CfgHeight[] | null,
  isServiceOrder?: boolean,
): number {
  if (sentValue !== undefined && sentValue !== null) {
    return Number(sentValue) || 0;
  }
  if (isServiceOrder) return 0;
  return deriveTotalHeightSurchargeSen(
    totalHeightInches(gapInches, divanHeightInches, legHeightInches),
    cfgTotalHeights,
  );
}
