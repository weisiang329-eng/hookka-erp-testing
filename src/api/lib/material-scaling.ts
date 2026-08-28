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
//   effectiveQty = max(0, baseQty + Σ over rules:
//                    (SOLine[rule.dim] - rule.baseValue) * rule.perUnit)
//
// SYMMETRIC semantics (since 2026-05-07): the BOM is recorded against a
// canonical / typical spec, NOT the smallest spec. Orders LARGER than the
// baseline scale UP linearly; orders SMALLER scale DOWN linearly with the
// same perUnit slope. The final effectiveQty is floored at 0 so a wildly
// out-of-range dimension can never create a negative consumption.
//
// User example (bedframe fabric, two rules stacked):
//   - Base recipe:  1.5 m of fabric @ divan 8" + gap 0"
//   - Rule A:       0.2 m per inch divan delta vs 8"
//   - Rule B:       0.1 m per inch gap delta vs 0"
//   - SO line:      divan 10", gap 2"
//   - Effective:    1.5 + (10−8)*0.2 + (2−0)*0.1 = 2.1 m
//   - SO line:      divan 6", gap 0"
//   - Effective:    1.5 + (6−8)*0.2 + (0−0)*0.1 = 1.1 m   (scales DOWN)
//
// Sofa fabric example:
//   - Base recipe: 5 metres of fabric @ seat height 30"
//   - perUnit:     0.3 metres per inch delta vs 30"
//   - SO line:     seat height 33"
//   - Effective:   5 + (33 - 30) * 0.3 = 5.9 metres
//   - SO line at 27": 5 + (27 - 30) * 0.3 = 4.1 metres   (scales DOWN)
//
// Migration note: pre-2026-05-07 callers relied on floor-only semantics
// (max(0, dim - baseValue)). Existing scaling rules were authored against
// the smallest possible build, so dim was always >= baseValue and the
// floor never kicked in. Switching to symmetric is therefore a no-op for
// those rules but enables authors to record canonical baselines plus
// bidirectional perUnit slopes — closer to how production actually
// estimates fabric consumption (more for bigger, less for smaller).
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
  /** Extra PIECES per inch over base. Right for discrete parts — a leg, a screw. */
  perUnit: number;
  /**
   * Extra CUT INCHES per inch over base, per axis. Added 2026-08-21.
   *
   * A cut material does not arrive in more pieces when the order grows; the
   * same piece is cut bigger. Owner, on a sofa seat: 「通常是长度变而已」— so the
   * two axes move independently and either may be zero.
   *
   * They ride on THIS rule rather than carrying their own baseline: two
   * baselines for "over base" is a disagreement waiting to happen.
   *
   * Absent or zero means the cut is fixed, which is what every BOM written
   * before today already means. No stored data changes behaviour.
   */
  cutLengthPerUnit?: number;
  cutWidthPerUnit?: number;
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
 * Each rule contributes (dim - rule.baseValue) * rule.perUnit
 * INDEPENDENTLY (signed — a dim BELOW baseValue contributes a negative
 * value, scaling consumption DOWN). Contributions are summed onto
 * baseQty; the final result is floored at 0 so wildly small dimensions
 * can't push consumption negative.
 *
 * A rule whose dimension is missing on the PO contributes 0 (fallback
 * to baseQty for that rule, not the whole row).
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
    // Symmetric: signed delta. dim above baseValue scales UP, below
    // scales DOWN by the same perUnit slope. Floor at 0 happens AFTER
    // the sum so one rule's negative pull can be offset by another
    // rule's positive push (mirrors the floor-at-end docstring above).
    const delta = dimValue - rule.baseValue;
    qty += delta * rule.perUnit;
  }
  // Final floor: never let scaling drive consumption negative even if
  // the operator entered an out-of-range dim or a perUnit slope is
  // unrealistically steep.
  return Math.max(0, qty);
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
/**
 * Grow a cut size by the scaling rules.
 *
 * Symmetric with {@link expandMaterialQty} on purpose: an order BELOW the
 * baseline shrinks the cut on the same slope, because the BOM records a typical
 * spec, not the smallest one. Both axes floor at 0 — a negative side is a bug,
 * not a credit.
 *
 * Rules whose slopes are both zero are skipped entirely, so a BOM that only
 * scales piece count is untouched.
 */
export function expandCutSize(
  baseLengthIn: number,
  baseWidthIn: number,
  scaling: MaterialScaling | MaterialScaling[] | null | undefined,
  dims: ProductionDimensions,
): { lengthIn: number; widthIn: number } {
  let lengthIn = baseLengthIn;
  let widthIn = baseWidthIn;
  if (!scaling) return { lengthIn, widthIn };
  const rules = Array.isArray(scaling) ? scaling : [scaling];
  for (const rule of rules) {
    if (!rule) continue;
    const dL = Number(rule.cutLengthPerUnit ?? 0);
    const dW = Number(rule.cutWidthPerUnit ?? 0);
    if (!Number.isFinite(dL) || !Number.isFinite(dW)) continue;
    if (dL === 0 && dW === 0) continue;
    if (typeof rule.baseValue !== "number" || !Number.isFinite(rule.baseValue)) continue;
    const dimValue = pickDimension(rule.dimension, dims);
    if (dimValue == null) continue;
    const delta = dimValue - rule.baseValue;
    lengthIn += delta * dL;
    widthIn += delta * dW;
  }
  return { lengthIn: Math.max(0, lengthIn), widthIn: Math.max(0, widthIn) };
}

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
  // The two cut slopes are optional and default to 0, so every rule stored
  // before 2026-08-21 parses to "the cut does not grow" — exactly what it meant.
  const cutLengthPerUnit = Number((r as { cutLengthPerUnit?: unknown }).cutLengthPerUnit) || 0;
  const cutWidthPerUnit = Number((r as { cutWidthPerUnit?: unknown }).cutWidthPerUnit) || 0;
  return { dimension: dim, baseValue, perUnit, cutLengthPerUnit, cutWidthPerUnit };
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
