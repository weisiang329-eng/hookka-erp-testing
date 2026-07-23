// ---------------------------------------------------------------------------
// Sofa combo pricing — single source of truth (backend).
//
// A "combo" sells a set of sofa pieces (e.g. 2A(LHF) + L(RHF)) for a negotiated
// total that is LESS than the sum of the pieces' per-seat-size prices. The
// discount is renegotiated onto each piece's basePriceSen so the group sum
// equals the combo total exactly — no separate discount column needed.
//
// This is a VERBATIM port of the logic that used to live in the Sales Order
// CREATE page (src/pages/sales/create.tsx — comboMatches + the submit-time
// distribution). It now runs on the backend so POST (create), PUT (edit) and
// any API path apply it identically — fixing the bug where editing a combo SO
// dropped the discount (the edit page had no combo logic).
//
// BYTE-IDENTICAL CONTRACT: this must reproduce the create page's old output to
// the sen, or existing combo SO prices would shift. Every Math.floor / round /
// Math.max / sort comparator below is copied exactly from the frontend. The
// fabric TIER is resolved by the CALLER (sofaPriceTier ?? priceTier ?? null;
// null disqualifies the group) and passed in, so this module stays pure.
// ---------------------------------------------------------------------------
import { calculateUnitPrice, calculateLineTotal } from "../../lib/pricing";

export type SofaTier = "PRICE_1" | "PRICE_2" | "PRICE_3";

/** One resolved order line, as the combo pass needs to see it. */
export type ComboLineInput = {
  /** Stable per-line id (the invoice/SO item id) — replaces the FE `_uid`. */
  key: string;
  itemCategory: string;
  baseModel: string;
  sizeCode: string;
  /** Bare seat-size key (e.g. "28"), matching the rule's pricesByHeight keys. */
  seatHeight: string;
  /** Present-or-empty fabric code — drives the FE-identical sofa-line filter. */
  fabricCode: string;
  /** Resolved tier (sofaPriceTier ?? priceTier ?? null). null disqualifies. */
  fabricTier: SofaTier | null;
  basePriceSen: number;
  divanPriceSen: number;
  legPriceSen: number;
  totalHeightPriceSen: number;
  specialOrderPriceSen: number;
  quantity: number;
};

export type ComboRuleInput = {
  baseModel: string;
  componentSizes: string[] | string[][];
  fabricTier: "ANY" | SofaTier;
  pricesByHeight: Record<string, number>;
  customerId: string | null;
  effectiveFrom: string;
};

export type ComboMatch = {
  baseModel: string;
  seatHeight: string;
  fabricTier: string;
  customerSpecific: boolean;
  discountSen: number;
  comboTotalSen: number;
  components: string[];
  affectedKeys: string[];
};

export type ComboResult = {
  /** key → new basePriceSen, ONLY for lines the combo renegotiated. */
  newBaseByKey: Map<string, number>;
  matches: ComboMatch[];
  totalDiscountSen: number;
};

function lineTotalOf(l: ComboLineInput): number {
  const unit = calculateUnitPrice({
    basePriceSen: l.basePriceSen,
    divanPriceSen: l.divanPriceSen,
    legPriceSen: l.legPriceSen,
    totalHeightPriceSen: l.totalHeightPriceSen,
    specialOrderPriceSen: l.specialOrderPriceSen,
  });
  return calculateLineTotal(unit, l.quantity);
}

// Greedy subset match — verbatim from create.tsx findComboSubset. Handles both
// the legacy flat shape (string[], exact size per slot) and the new OR-group
// shape (string[][], any-of per slot). Consumes one line per slot; returns null
// if any slot can't be filled.
function findComboSubset<L extends { sizeCode: string }>(
  groups: string[] | string[][],
  lines: L[],
): L[] | null {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const isGrouped = Array.isArray(groups[0]);
  const remaining = lines.slice();
  const matched: L[] = [];
  if (!isGrouped) {
    for (const ruleSize of groups as string[]) {
      const idx = remaining.findIndex((l) => l.sizeCode === ruleSize);
      if (idx === -1) return null;
      matched.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
    return matched;
  }
  for (const groupOpts of groups as string[][]) {
    const idx = remaining.findIndex((l) => groupOpts.includes(l.sizeCode));
    if (idx === -1) return null;
    matched.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return matched;
}

/**
 * Detect sofa combos in the resolved lines and renegotiate the affected lines'
 * basePriceSen down to the combo total. Pure + deterministic.
 *
 * @returns newBaseByKey (only changed lines), the matches (for logging/tests),
 *          and the total discount in sen.
 */
export function applySofaCombos(
  lines: ComboLineInput[],
  rules: ComboRuleInput[],
  opts: { customerId: string; todayDateStr: string },
): ComboResult {
  const { customerId, todayDateStr } = opts;
  const newBaseByKey = new Map<string, number>();
  const matches: ComboMatch[] = [];

  // Only complete SOFA lines participate — same filter as the FE.
  const sofaLines = lines.filter(
    (it) =>
      it.itemCategory === "SOFA" &&
      !!it.baseModel &&
      !!it.seatHeight &&
      !!it.fabricCode,
  );
  if (sofaLines.length === 0 || rules.length === 0) {
    return { newBaseByKey, matches, totalDiscountSen: 0 };
  }

  const byBase = new Map<string, ComboLineInput[]>();
  for (const l of sofaLines) {
    const arr = byBase.get(l.baseModel) ?? [];
    arr.push(l);
    byBase.set(l.baseModel, arr);
  }

  for (const [baseModel, group] of byBase) {
    // Uniform tier across group, else combo doesn't apply (null disqualifies).
    const tiers = new Set<SofaTier | null>();
    for (const g of group) tiers.add(g.fabricTier);
    if (tiers.size > 1 || tiers.has(null)) continue;
    const groupTier = ([...tiers][0] ?? null) as SofaTier | null;
    if (!groupTier) continue;
    // Uniform seat height required (combo prices are per height).
    const heights = new Set(group.map((g) => g.seatHeight));
    if (heights.size > 1) continue;
    const seatHeight = [...heights][0];

    // Priority: (customer+tier) > (customer+ANY) > (company+tier) > (company+ANY).
    const priorityOf = (r: ComboRuleInput): number => {
      const isCustomer = r.customerId === customerId && customerId !== "";
      const tierMatch = r.fabricTier === groupTier;
      if (isCustomer && tierMatch) return 4;
      if (isCustomer && r.fabricTier === "ANY") return 3;
      if (!r.customerId && tierMatch) return 2;
      if (!r.customerId && r.fabricTier === "ANY") return 1;
      return 0;
    };

    // A group can hold MULTIPLE complete sets (a customer ordering two identical
    // sofa combos). findComboSubset consumes ONE set per call, so we re-match on
    // the REMAINING lines until no combo is left — otherwise only the first set
    // gets the discount and the rest stay full-retail, i.e. the 2nd+ set is
    // OVER-charged (owner 2026-07-23: "买第二 set 不可能更贵"). Bounded by
    // group.length: every pass consumes ≥1 line via `remaining`.
    let remaining: ComboLineInput[] = group.slice();
    for (let guard = group.length; guard > 0 && remaining.length > 0; guard--) {
      const candidates = rules
        .filter((r) => r.baseModel === baseModel && r.effectiveFrom <= todayDateStr)
        .map((r) => ({ r, subset: findComboSubset(r.componentSizes, remaining) }))
        .filter(
          (x): x is { r: ComboRuleInput; subset: ComboLineInput[] } =>
            x.subset !== null,
        );
      if (candidates.length === 0) break;

      const best = candidates
        .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1))[0];
      if (!best) break;

      // Consume this set from `remaining` regardless of discount so a following
      // identical set can still be matched (and an already-combo'd first set
      // doesn't block a discountable second one).
      const consumed = new Set(best.subset.map((l) => l.key));
      remaining = remaining.filter((l) => !consumed.has(l.key));

      const comboTotal = best.r.pricesByHeight[seatHeight];
      if (typeof comboTotal !== "number" || comboTotal <= 0) continue;
      const subsetSum = best.subset.reduce((s, g) => s + lineTotalOf(g), 0);
      const discount = subsetSum - comboTotal;
      if (discount <= 0) continue; // already at/below combo total — no re-price

      matches.push({
        baseModel,
        seatHeight,
        fabricTier: best.r.fabricTier,
        customerSpecific: best.r.customerId === customerId && customerId !== "",
        discountSen: discount,
        comboTotalSen: comboTotal,
        components: best.subset.map((l) => l.sizeCode),
        affectedKeys: best.subset.map((l) => l.key),
      });
    }
  }

  // Distribute each combo's total back onto the affected lines' basePriceSen.
  // Verbatim from create.tsx (floor → round → residual-to-highest-base line).
  for (const m of matches) {
    const groupLines = lines.filter((l) => m.affectedKeys.includes(l.key));
    const groupSum = groupLines.reduce((s, l) => s + lineTotalOf(l), 0);
    if (groupSum <= 0) continue;
    const ratio = m.comboTotalSen / groupSum;
    for (const l of groupLines) {
      const lineTotal = lineTotalOf(l);
      const adjustedLineTotal = Math.floor(lineTotal * ratio);
      const surchargesPerUnit =
        (l.divanPriceSen || 0) +
        (l.legPriceSen || 0) +
        (l.totalHeightPriceSen || 0) +
        (l.specialOrderPriceSen || 0);
      const adjustedUnit = Math.max(
        0,
        Math.round(adjustedLineTotal / Math.max(1, l.quantity)),
      );
      const newBase = Math.max(0, adjustedUnit - surchargesPerUnit);
      newBaseByKey.set(l.key, newBase);
    }
    const newGroupSum = groupLines.reduce((s, l) => {
      const newBase = newBaseByKey.get(l.key) ?? l.basePriceSen;
      const unit =
        newBase +
        (l.divanPriceSen || 0) +
        (l.legPriceSen || 0) +
        (l.totalHeightPriceSen || 0) +
        (l.specialOrderPriceSen || 0);
      return s + unit * l.quantity;
    }, 0);
    const residual = m.comboTotalSen - newGroupSum;
    if (residual !== 0 && groupLines.length > 0) {
      const target = groupLines
        .slice()
        .sort(
          (a, b) =>
            (newBaseByKey.get(b.key) ?? b.basePriceSen) -
            (newBaseByKey.get(a.key) ?? a.basePriceSen),
        )[0];
      const cur = newBaseByKey.get(target.key) ?? target.basePriceSen;
      newBaseByKey.set(
        target.key,
        Math.max(0, cur + Math.round(residual / Math.max(1, target.quantity))),
      );
    }
  }

  const totalDiscountSen = matches.reduce((s, m) => s + m.discountSen, 0);
  return { newBaseByKey, matches, totalDiscountSen };
}
