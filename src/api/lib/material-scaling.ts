// ---------------------------------------------------------------------------
// material-scaling.ts — dimension-driven scaling for BOM WIP raw materials.
//
// Each WIPMaterial may carry zero or more `scaling` rules:
//
//   [{ dimension, baseValue, perUnit }, ...]
//
// At consumption time (MRP forecast, PO completion FIFO consumption,
// future cost ledger), we expand the base qty by SUMMING every rule's
// contribution:
//
//   effectiveQty = baseQty + Σ over rules:
//                    max(0, SOLine[rule.dim] - rule.baseValue) * rule.perUnit
//
// FLOOR semantics: the BOM is recorded against the smallest spec build,
// so orders SMALLER than the baseline still consume the full baseQty
// (we never decrease — `max(0, …)` clamps the negative delta to zero
// per-rule, so a small dim on one rule doesn't subtract from another
// rule's contribution). Orders larger than baseline scale up linearly
// per inch on each independent dimension.
//
// User example (bedframe fabric, two rules stacked):
//   - Base recipe:  1.5 m of fabric @ divan 8" + gap 0"
//   - Rule A:       +0.2 m per inch divan over 8"
//   - Rule B:       +0.1 m per inch gap over 0"
//   - SO line:      divan 10", gap 2"
//   - Effective:    1.5 + (10−8)*0.2 + (2−0)*0.1 = 2.1 m
//
// Single-rule legacy example (sofa fabric):
//   - Base recipe: 5 metres of fabric @ seat height 24"
//   - perUnit:     0.2 metres per inch over 24
//   - SO line:     seat height 27"
//   - Effective:   5 + max(0, 27 - 24) * 0.2 = 5.6 metres
//   - SO line at 22": 5 + max(0, 22 - 24) * 0.2 = 5 metres (floored)
//
// Backwards compat: parseMaterialScaling accepts BOTH the legacy single-
// object shape AND the new array shape, normalising to MaterialScaling[].
// bom_versions.tree is opaque JSON so no DB migration is needed.
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
 * Apply every scaling rule and return the effective qty to consume.
 *
 * Each rule contributes max(0, dim - rule.baseValue) * rule.perUnit
 * INDEPENDENTLY; the contributions are summed onto baseQty. A rule
 * whose dimension is missing on the PO contributes 0 (fallback to
 * baseQty for that rule, not the whole row).
 *
 * Defensive against malformed JSON: rules missing or with non-finite
 * baseValue / perUnit contribute 0. An empty / null / undefined rules
 * list returns baseQty unchanged.
 *
 * Accepts a single rule for ergonomic call-site compat — this is just
 * normalised to a 1-element array internally.
 */
export function expandMaterialQty(
  baseQty: number,
  scaling: MaterialScaling | MaterialScaling[] | null | undefined,
  dims: ProductionDimensions,
): number {
  if (!scaling) return baseQty;
  const rules = Array.isArray(scaling) ? scaling : [scaling];
  if (rules.length === 0) return baseQty;
  let qty = baseQty;
  for (const rule of rules) {
    if (!rule) continue;
    if (
      typeof rule.baseValue !== "number" ||
      typeof rule.perUnit !== "number" ||
      !Number.isFinite(rule.baseValue) ||
      !Number.isFinite(rule.perUnit)
    ) {
      continue;
    }
    const dimValue = pickDimension(rule.dimension, dims);
    if (dimValue == null) continue;
    const delta = Math.max(0, dimValue - rule.baseValue);
    qty += delta * rule.perUnit;
  }
  return qty;
}

/**
 * Type guard for parsing untrusted JSON (BOM template wipComponents
 * blob, mock seed data). Returns an array of typed scaling rules.
 *
 * Accepts BOTH:
 *   - legacy single-object shape: { dimension, baseValue, perUnit }
 *     → normalised to a 1-element array
 *   - new array shape: [{ ... }, { ... }]
 *
 * Invalid / partially-malformed entries are filtered out. Returns []
 * when input is null / not an object / not a valid rule shape.
 *
 * Verification (the canonical mixed-rule check):
 *   rules = [
 *     { dimension: "divan",  baseValue: 8, perUnit: 0.2 },
 *     { dimension: "gap",    baseValue: 0, perUnit: 0.1 },
 *   ]
 *   qty   = 1.5
 *   dims  = { divanHeightInches: 10, gapInches: 2 }
 *   →     1.5 + (10−8)*0.2 + (2−0)*0.1 = 2.1
 */
export function parseMaterialScaling(raw: unknown): MaterialScaling[] {
  if (raw == null) return [];
  // Array shape (new): filter each entry through parseOne.
  if (Array.isArray(raw)) {
    const out: MaterialScaling[] = [];
    for (const entry of raw) {
      const parsed = parseOneScaling(entry);
      if (parsed) out.push(parsed);
    }
    return out;
  }
  // Legacy single-object shape: normalise to 1-element array.
  const one = parseOneScaling(raw);
  return one ? [one] : [];
}

function parseOneScaling(raw: unknown): MaterialScaling | null {
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
