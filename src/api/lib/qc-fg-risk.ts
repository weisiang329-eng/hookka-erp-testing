// ---------------------------------------------------------------------------
// WHICH finished unit gets sampled — the risk weighting for OQC.
//
// WHY THIS EXISTS
// ---------------
// The first version of FG sampling drew `clamp(ceil(n × 0.10), 1, 5)` units in
// whatever order the database returned them. The share was right; the DRAW was
// arbitrary, and an arbitrary draw over a day that is mostly repeat production
// spends the inspection on the model the factory has built four hundred times.
//
// Owner 2026-08-08: "那些特别少出现的一些 order … 一些款式，看手工等等 … 尤其是
// 我们 service case 里面有的东西". Three signals, and he ranked them: the last
// one is the strongest.
//
// THE THREE SIGNALS, AND WHERE EACH ONE COMES FROM IN THE DATA
// ------------------------------------------------------------
// 1. PRIOR COMPLAINT (strongest). A product code, or a customer, that has
//    already appeared on a `service_cases` row. This is the loop the owner is
//    actually asking for: the complaint that came back last month decides what
//    gets looked at before the next one goes out of the door. A case whose root
//    cause was recorded as OURS (PRODUCTION / MATERIAL / PROCESS) weighs more
//    than one blamed on transport or the customer, because only ours is
//    repeatable at the bench. Read off service_cases → service_orders →
//    service_order_lines.product_code, and off the case's source sales order
//    for cases logged without a repair order.
//
// 2. RARITY. Counted, never hand-kept: how many units of that product code the
//    factory has finished in the last `FG_RARITY_WINDOW_DAYS`. A model built
//    twice this year is one nobody has muscle memory for; a model built four
//    hundred times is not where the surprises are. This is deliberately a COUNT
//    over `fg_units` rather than a "special model" list, because a list stops
//    being true and nobody notices.
//
// 3. WORKMANSHIP. What the data actually carries:
//      • `bom_versions.total_minutes` for the ACTIVE version of that product
//        code, compared against the MEDIAN across the whole active catalogue.
//        Standard minutes is the factory's own statement of how much hand work
//        a model takes, so a model well above the median is a model where the
//        hands matter.
//      • `sales_order_items.special_order` — a one-off written instruction is
//        both unusual AND hand-executed, which is the definition of the risk.
//      • `sales_order_items.notes` on the line, same reasoning, weaker.
//    NOTE: there is NO tufting / button-count field anywhere in this schema
//    (the only occurrence of the word is a WIP checklist item), so the buttoned
//    and deep-tufted models are reached through standard minutes and the
//    special-order flag rather than directly. If a tufting spec is ever added
//    to the BOM it slots in here as one more signal.
//
// EVERY DRAWN UNIT RECORDS WHY. `scoreFgUnit` returns the reasons alongside the
// score and they are frozen onto the inspection, because "you have been handed
// this sofa because its product code is on two open complaints" and "you have
// been handed this sofa because we build one a year" are different jobs, and an
// inspector who is not told which is doing neither.
//
// FAIL-SOFT. Every signal is optional. A missing BOM, an empty service-case
// table or a failed lookup scores 0 for that signal and the draw degrades
// toward the old arbitrary one — never toward generating nothing.
// ---------------------------------------------------------------------------

/** How far back "how often do we build this" is counted. */
export const FG_RARITY_WINDOW_DAYS = 180;

/** How far back a complaint still counts against a product code. */
export const FG_SERVICE_CASE_WINDOW_DAYS = 730;

/**
 * Root causes that mean the fault was OURS and is repeatable at the bench.
 * A case blamed on TRANSPORT or the CUSTOMER is a real complaint but it is not
 * a reason to look harder at the next unit off the line.
 */
export const OUR_FAULT_ROOT_CAUSES = new Set(["PRODUCTION", "DESIGN", "MATERIAL", "PROCESS"]);

export type FgRiskSignals = {
  /** Units of this product code finished in the rarity window (this one included). */
  unitsOfProductCode?: number | null;
  /** Standard minutes on the ACTIVE BOM for this product code. */
  bomTotalMinutes?: number | null;
  /** Median standard minutes across the active catalogue — the yardstick. */
  medianBomMinutes?: number | null;
  /** The sales-order line's special-order instruction, if any. */
  specialOrder?: string | null;
  /** Free-text notes on the sales-order line. */
  lineNotes?: string | null;
  /** Service cases whose product code matches this unit's. */
  serviceCaseProductHits?: number | null;
  /** …of which had a root cause recorded as ours. */
  serviceCaseProductOurFaultHits?: number | null;
  /** Service cases raised by this unit's customer. */
  serviceCaseCustomerHits?: number | null;
};

export type FgDrawReason = {
  /** Stable machine code — safe to filter or count on later. */
  code: string;
  /** What the inspector reads. Written to be actionable, not to be a label. */
  label: string;
  weight: number;
};

export type FgRiskScore = { score: number; reasons: FgDrawReason[] };

const W = {
  SERVICE_CASE_PRODUCT: 50,
  SERVICE_CASE_PRODUCT_REPEAT: 10, // per extra case…
  SERVICE_CASE_PRODUCT_REPEAT_MAX: 30, // …capped here
  SERVICE_CASE_OUR_FAULT: 15,
  SERVICE_CASE_CUSTOMER: 20,
  RARE_VERY: 30,
  RARE: 18,
  UNCOMMON: 8,
  SPECIAL_ORDER: 25,
  LINE_NOTES: 8,
  LABOUR_VERY_HEAVY: 20,
  LABOUR_HEAVY: 10,
} as const;

/** Rarity bands, in units produced over FG_RARITY_WINDOW_DAYS. */
const RARE_VERY_MAX = 2;
const RARE_MAX = 5;
const UNCOMMON_MAX = 10;

/** Standard minutes above this multiple of the catalogue median is hand-heavy. */
const LABOUR_VERY_HEAVY_RATIO = 1.5;
const LABOUR_HEAVY_RATIO = 1.2;

function isFilled(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Score one candidate unit, and say why.
 *
 * Additive on purpose: a rare, hand-heavy model that is ALSO on a complaint is
 * exactly the unit that should out-rank all three of them separately, and a
 * max() would flatten that. Higher is drawn first; 0 means nothing is known
 * against this unit, which is a perfectly normal answer on a day of repeat
 * production.
 */
export function scoreFgUnit(signals: FgRiskSignals): FgRiskScore {
  const reasons: FgDrawReason[] = [];

  // --- 1. prior complaint — the strongest signal, and the one the owner
  // singled out. This is the whole loop: the complaint decides what we look at
  // before the next one ships.
  const productHits = Math.max(0, Number(signals.serviceCaseProductHits ?? 0) || 0);
  if (productHits > 0) {
    const repeat = Math.min(
      W.SERVICE_CASE_PRODUCT_REPEAT_MAX,
      (productHits - 1) * W.SERVICE_CASE_PRODUCT_REPEAT,
    );
    reasons.push({
      code: "SERVICE_CASE_PRODUCT",
      label:
        productHits === 1
          ? "This product code has a service case against it — look for the same fault again"
          : `This product code has ${productHits} service cases against it — look for the same fault again`,
      weight: W.SERVICE_CASE_PRODUCT + repeat,
    });
  }
  const ourFault = Math.max(0, Number(signals.serviceCaseProductOurFaultHits ?? 0) || 0);
  if (ourFault > 0) {
    reasons.push({
      code: "SERVICE_CASE_OUR_FAULT",
      label:
        "A past complaint on this product was traced to our own production, design, material or process — the kind that repeats",
      weight: W.SERVICE_CASE_OUR_FAULT,
    });
  }
  const customerHits = Math.max(0, Number(signals.serviceCaseCustomerHits ?? 0) || 0);
  if (customerHits > 0) {
    reasons.push({
      code: "SERVICE_CASE_CUSTOMER",
      label: `This customer has raised ${customerHits} service case${customerHits === 1 ? "" : "s"} before`,
      weight: W.SERVICE_CASE_CUSTOMER,
    });
  }

  // --- 2. rarity, counted rather than declared.
  const units = signals.unitsOfProductCode;
  if (typeof units === "number" && units > 0) {
    if (units <= RARE_VERY_MAX) {
      reasons.push({
        code: "RARE_PRODUCT",
        label: `Only ${units} of this product code built in the last ${FG_RARITY_WINDOW_DAYS} days — nobody has done this often`,
        weight: W.RARE_VERY,
      });
    } else if (units <= RARE_MAX) {
      reasons.push({
        code: "RARE_PRODUCT",
        label: `Only ${units} of this product code built in the last ${FG_RARITY_WINDOW_DAYS} days`,
        weight: W.RARE,
      });
    } else if (units <= UNCOMMON_MAX) {
      reasons.push({
        code: "UNCOMMON_PRODUCT",
        label: `${units} of this product code built in the last ${FG_RARITY_WINDOW_DAYS} days — not a routine model`,
        weight: W.UNCOMMON,
      });
    }
  }

  // --- 3. workmanship.
  if (isFilled(signals.specialOrder)) {
    reasons.push({
      code: "SPECIAL_ORDER",
      label: "One-off special-order instruction on this line — check it was done, exactly as written",
      weight: W.SPECIAL_ORDER,
    });
  }
  const minutes = Number(signals.bomTotalMinutes ?? 0) || 0;
  const median = Number(signals.medianBomMinutes ?? 0) || 0;
  if (minutes > 0 && median > 0) {
    if (minutes >= median * LABOUR_VERY_HEAVY_RATIO) {
      reasons.push({
        code: "LABOUR_HEAVY",
        label: `${Math.round(minutes)} standard minutes against a catalogue median of ${Math.round(median)} — a hand-heavy model`,
        weight: W.LABOUR_VERY_HEAVY,
      });
    } else if (minutes >= median * LABOUR_HEAVY_RATIO) {
      reasons.push({
        code: "LABOUR_ABOVE_AVERAGE",
        label: `${Math.round(minutes)} standard minutes, above the catalogue median of ${Math.round(median)}`,
        weight: W.LABOUR_HEAVY,
      });
    }
  }
  if (isFilled(signals.lineNotes)) {
    reasons.push({
      code: "LINE_NOTES",
      label: "The sales-order line carries a written instruction — confirm it on the unit",
      weight: W.LINE_NOTES,
    });
  }

  return { score: reasons.reduce((n, r) => n + r.weight, 0), reasons };
}

/**
 * One line the inspector can read at the top of the checklist.
 * Deliberately not "score 73" — a number tells them nothing about what to look
 * at. Kept to the two strongest reasons so it stays a sentence.
 */
export function drawReasonSummary(score: FgRiskScore): string {
  if (score.reasons.length === 0) {
    return "Routine sample of today's production.";
  }
  return [...score.reasons]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((r) => r.label)
    .join(". ")
    .concat(".");
}
