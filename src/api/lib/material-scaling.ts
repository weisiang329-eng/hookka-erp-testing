// ---------------------------------------------------------------------------
// material-scaling.ts — dimension-driven scaling for BOM WIP raw materials.
//
// Each WIPMaterial may carry an optional `scaling` rule:
//
//   { dimension, baseValue, perUnit }
//
// At consumption time (MRP forecast, PO completion FIFO consumption,
// future cost ledger), we expand the base qty using the SO/PO line
// dimensions:
//
//   effectiveQty = baseQty + max(0, dim - baseValue) * perUnit
//
// FLOOR semantics: the BOM is recorded against the smallest spec build,
// so orders SMALLER than the baseline still consume the full baseQty
// (we never decrease — `max(0, …)` clamps the negative delta to zero).
// Orders larger than baseline scale up linearly per inch.
//
// User example (sofa fabric):
//   - Base recipe: 5 metres of fabric @ seat height 24"
//   - perUnit:     0.2 metres per inch over 24
//   - SO line:     seat height 27"
//   - Effective:   5 + max(0, 27 - 24) * 0.2 = 5.6 metres
//   - SO line at 22": 5 + max(0, 22 - 24) * 0.2 = 5 metres (floored)
//
// ---------------------------------------------------------------------------

export type MaterialScalingDimension =
  | "gap"          // SOLine.gapInches              (bedframe)
  | "divan"        // SOLine.divanHeightInches      (bedframe)
  | "leg"          // SOLine.legHeightInches        (bedframe + sofa legs)
  | "totalHeight"  // gap + divan + leg             (bedframe stack)
  | "seatHeight";  // sofa seat height in inches    (sofa)

export type MaterialScaling = {
  dimension: MaterialScalingDimension;
  baseValue: number;
  perUnit: number;
};

/**
 * Dimensions extracted from a Production Order (or the originating
 * SO/CO line). All fields are optional — the formula falls back to base
 * qty when the relevant dimension is missing.
 *
 * `seatHeightInches` for sofas is derived at the call site by parsing
 * the integer prefix off `production_orders.sizeCode` (e.g. "28" or
 * "28\""). There's no dedicated column for it; sofa SO line entry
 * stores it inline in sizeCode/sizeLabel.
 */
export type ProductionDimensions = {
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  seatHeightInches?: number | null;
};

/**
 * Resolve which numeric dimension a scaling rule should compare against.
 * Returns null when the relevant SOLine field isn't populated — caller
 * should treat that as "no scaling, use baseQty".
 */
export function pickDimension(
  dim: MaterialScalingDimension,
  dims: ProductionDimensions,
): number | null {
  switch (dim) {
    case "gap":
      return dims.gapInches ?? null;
    case "divan":
      return dims.divanHeightInches ?? null;
    case "leg":
      return dims.legHeightInches ?? null;
    case "seatHeight":
      return dims.seatHeightInches ?? null;
    case "totalHeight": {
      // Returns null only when ALL three are null. Mixed values default
      // missing parts to 0 — e.g. an accessory order with only `gap=4`
      // resolves totalHeight to 4, which is fine because the BOM author
      // chose totalHeight as a proxy for "stack the user controls".
      const g = dims.gapInches;
      const d = dims.divanHeightInches;
      const l = dims.legHeightInches;
      if (g == null && d == null && l == null) return null;
      return (g ?? 0) + (d ?? 0) + (l ?? 0);
    }
  }
}

/**
 * Apply the scaling rule. Returns the effective qty to consume.
 *
 * Defensive against malformed JSON: if scaling is present but missing
 * baseValue / perUnit, falls back to baseQty unchanged.
 */
export function expandMaterialQty(
  baseQty: number,
  scaling: MaterialScaling | null | undefined,
  dims: ProductionDimensions,
): number {
  if (!scaling) return baseQty;
  if (
    typeof scaling.baseValue !== "number" ||
    typeof scaling.perUnit !== "number" ||
    !Number.isFinite(scaling.baseValue) ||
    !Number.isFinite(scaling.perUnit)
  ) {
    return baseQty;
  }
  const dimValue = pickDimension(scaling.dimension, dims);
  if (dimValue == null) return baseQty;
  const delta = Math.max(0, dimValue - scaling.baseValue);
  return baseQty + delta * scaling.perUnit;
}

/**
 * Type guard for parsing untrusted JSON (BOM template wipComponents
 * blob, mock seed data). Returns the typed scaling rule or null if any
 * required field is missing or of the wrong type.
 */
export function parseMaterialScaling(raw: unknown): MaterialScaling | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const dim = r.dimension;
  if (
    dim !== "gap" &&
    dim !== "divan" &&
    dim !== "leg" &&
    dim !== "totalHeight" &&
    dim !== "seatHeight"
  ) {
    return null;
  }
  const baseValue =
    typeof r.baseValue === "number" ? r.baseValue : Number(r.baseValue);
  const perUnit = typeof r.perUnit === "number" ? r.perUnit : Number(r.perUnit);
  if (!Number.isFinite(baseValue) || !Number.isFinite(perUnit)) return null;
  return { dimension: dim, baseValue, perUnit };
}

/**
 * Parse the integer-inches sofa seat height out of a sizeCode /
 * sizeLabel string. Sofa SO line entry stores it as e.g. "28" (sizeCode)
 * or '28"' (sizeLabel) — there's no dedicated INT column on
 * production_orders today.
 *
 * Returns null when the input doesn't lead with digits — bedframes use
 * sizeCode for "K" / "Q" / "S", which we don't want to mis-interpret as
 * a sofa seat height.
 */
export function parseSofaSeatHeightInches(
  sizeCode: string | null | undefined,
  sizeLabel?: string | null,
): number | null {
  for (const candidate of [sizeCode, sizeLabel]) {
    if (!candidate) continue;
    // Trim then match leading digits. Reject if the leading char isn't a
    // digit — "Q" / "K" / "1NA" etc. should NOT parse to a number even
    // though parseInt("1NA") returns 1.
    const s = String(candidate).trim();
    if (!/^\d/.test(s)) continue;
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
