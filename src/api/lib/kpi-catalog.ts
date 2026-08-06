// ---------------------------------------------------------------------------
// kpi-catalog.ts — the KPIs that exist, and how each one is scored.
//
// Owner 2026-08-06: monthly settlement, assigned to a PERSON by Super Admin,
// and the person sees only their own card.
//
// Two shapes, deliberately:
//
//   GATE  — pass or fail, nothing in between. The owner's rule for the
//           customer's delivery date is "绝对不可以 overdue … 这是最低原则".
//           Expressing that as "96% on time" would say the opposite: that 4%
//           late is acceptable. A missed gate CAPS the whole score instead.
//   RATIO — target vs actual, reported as attainment %. Everything else.
//
// Every KPI names the query that produces it (src/api/lib/kpi-metrics.ts) and
// a drill-down route, because a number nobody can click is a number nobody
// trusts — the first question is always "which ones?".
//
// `available: false` means the data to compute it does not exist yet. Those
// are listed on the card, greyed, contributing nothing — so a half-built
// scorecard looks half-built rather than quietly scoring out of three.
// ---------------------------------------------------------------------------

/**
 * Every KPI is weighted the same way.
 *
 * There WAS a GATE shape that capped the whole month at 60 when the customer's
 * promised date was missed. Owner 2026-08-06: "我还是可以 assign，assign 是
 * assign 啊，为什么你要 cap 呢？应该说我 assign 这个东西给那个人，那个人就要顾."
 * Fair — assigning a KPI already makes it that person's to look after, and a
 * cap punishes twice for one miss while making the other five KPIs pointless
 * in a month where it happened. The shape is kept only so old assignment rows
 * keep loading; nothing caps any more.
 */
export type KpiShape = "GATE" | "RATIO";

/**
 * How the ACTUAL number is produced.
 *
 *   AUTO      — computed from data already in the system.
 *   CHECKLIST — a fixed list of actions defined here, ticked during the month
 *               and verified by Super Admin. actual = done ÷ total.
 *   SURVEY    — five questions sent to the customer, answered 1–5.
 *   MANUAL    — the supervisor types the score in at month end.
 *
 * MANUAL was removed on 2026-08-06 and put back on 2026-08-07, because the
 * owner drew the line differently from where I had drawn it. The earlier
 * ruling ("每一个 KPI 都必须是可以量化的") stands for everything that CAN be
 * counted, and AUTO / CHECKLIST / SURVEY are all measurable — the owner's own
 * split: "Auto：也就是 measurable 的 … Checklist：肯定也是 measurable 的，就是
 * 发给顾客评估 … 而这一个就不是 measurable 的，它是属于人工评分的."
 *
 * The case that forced it is "spot the problem before it grows". You cannot
 * count it, because a month with genuinely no problems and a month where the
 * person never looked produce the same zero. Only the supervisor can tell them
 * apart, and only afterwards: "如果他没有提出任何问题，事后却又有问题发生，那他
 * 的这个分数就会被上级评得很低." Forcing that into a checklist measured whether
 * the boxes got ticked, not whether anything was actually caught.
 *
 * A MANUAL KPI is still bounded and still shown to the employee in advance —
 * what it is for, what earns a high score, what earns a low one. What it is
 * not is derivable from the database, and pretending otherwise was the error.
 */
export type KpiScoring = "AUTO" | "CHECKLIST" | "SURVEY" | "MANUAL";

/**
 * How an actual turns into an attainment percentage.
 *
 *   TARGET_RATIO       — actual ÷ target (or target ÷ actual when lower is
 *                        better). The default.
 *   PENALTY_PER_PCT    — start at 100 and subtract `penaltyPerPct` for each
 *                        percentage point of the actual. Owner 2026-08-06 on
 *                        late deliveries: "如果有 1% 的订单延迟送货，就会扣 10
 *                        分 … 如果达到 10% 延迟，最多也就扣完这 100% 的分数."
 *                        A ratio cannot express that — 1% late against a target
 *                        of 0 divides by zero, and against a target of 100%
 *                        on-time it barely moves the number.
 *   PENALTY_PER_UNIT   — start at 100 and subtract `penaltyPerUnit` for each
 *                        WHOLE UNIT of the actual, where the actual is already
 *                        a count rather than a percentage. Owner 2026-08-07 on
 *                        invoicing: "一张单迟一天就扣10分 … 5张单1天就50分."
 *                        Five documents each one day late is the same fifty
 *                        points as one document five days late, which is what
 *                        the owner intends — the unit is the document-day.
 *   SURVEY_MEAN        — the average of the answers, already a 0–100 figure.
 *   MANUAL_SCORE       — the supervisor's number IS the attainment. No maths.
 */
export type AttainmentCurve =
  | "TARGET_RATIO"
  | "PENALTY_PER_PCT"
  | "PENALTY_PER_UNIT"
  | "SURVEY_MEAN"
  | "MANUAL_SCORE";
/** Higher actual is better, or lower is better (a count of problems). */
export type KpiDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";

export interface KpiDef {
  key: string;
  label: string;
  /** One line, shown under the label. */
  detail: string;
  shape: KpiShape;
  direction: KpiDirection;
  /** "%" | "count" | "score" — drives formatting, not maths. */
  unit: "%" | "count" | "score";
  scoring: KpiScoring;
  /**
   * Plain-English formula, shown to the EMPLOYEE on their own card.
   *
   * Owner 2026-08-06: "系统会提供一个完整的清单给员工，让他们清清楚楚地知道
   * 自己的 KPI 是如何计算和获取的." A score whose derivation is hidden gets
   * argued with instead of worked on.
   */
  formula: string;
  /**
   * What problem this KPI exists to solve.
   *
   * Owner 2026-08-06: "正常 KPI 都应该包含它的定义、标题对应的实际意思、以及它
   * 是为了解决什么问题." A title alone was ambiguous — "Customer delivery date"
   * reads as a date field, not as a measure of lateness.
   */
  purpose: string;
  /** Exactly what is counted, in the terms the shop floor uses. */
  definition: string;
  /** Step by step, how the number is produced. */
  measurement: string[];
  /** CHECKLIST only — the actions that make up the month. */
  checklistItems?: string[];
  /** SURVEY only — the questions, each answered 1–5. */
  surveyQuestions?: string[];
  curve?: AttainmentCurve;
  /** PENALTY_PER_PCT only — points lost per percentage point. */
  penaltyPerPct?: number;
  /** PENALTY_PER_UNIT only — points lost per whole unit of the actual. */
  penaltyPerUnit?: number;
  /** How many days are allowed before a document starts counting as late. */
  graceDays?: number;
  /** MANUAL only — what earns a high score, and what earns a low one. */
  ratingGuide?: string[];
  /** Suggested target; the assignment row overrides it per person. */
  defaultTarget: number;
  /**
   * A STARTING POINT for the weight box, not a fixed property of the KPI.
   *
   * Owner 2026-08-06: "我们 assign 给一个人的时候，我们再重新 set 过他的 KPI 的
   * 权重会比较好，不要直接特定一个 KPI 的权重是多少" — the same KPI matters
   * differently to different jobs, so the weight belongs to the assignment.
   */
  defaultWeight: number;
  /** False only while a data source genuinely does not exist. */
  available: boolean;
  /** Why it is not available, shown on the card. */
  blockedBy?: string;
  /** Where clicking the row goes. */
  drillPath?: string;
  /** Which roles this KPI is offered for. */
  roles: string[];
}

/**
 * Retained so stored rows and the API shape stay readable, but NOT applied.
 * See the note on KpiShape — the owner's ruling is that an assigned KPI is
 * weighted like any other.
 */
export const GATE_FAIL_CAP = 60;

export const KPI_CATALOG: KpiDef[] = [
  {
    key: "customer_delivery_date",
    label: "On-time delivery to the customer's promised date",
    detail: "Every 1% of orders shipped late costs 10 points",
    shape: "RATIO",
    direction: "LOWER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    curve: "PENALTY_PER_PCT",
    penaltyPerPct: 10,
    purpose:
      "A late delivery is the one failure the customer always notices. Everything else in the factory can slip; this is the promise we made.",
    definition:
      "The PERCENTAGE of sales orders shipped in the month whose first dispatch left after the date promised to that customer. Counted once per order, not per delivery note — a customer promised one date was let down once, however many trips it took.",
    measurement: [
      "Take the date promised to the customer on the sales order. Our own internal estimate is never used.",
      "Find the first dispatch date across every delivery order carrying that order's production.",
      "Late % = orders dispatched after the promised date ÷ orders dispatched that month × 100.",
      "Score starts at 100 and loses 10 points per 1% late: 0% → 100, 1% → 90, 5% → 50, 10% or worse → 0.",
      "That score is then multiplied by whatever weight this KPI was assigned.",
    ],
    formula: "100 − (late % × 10). 1% late costs 10 points; 10% late scores nothing.",
    defaultTarget: 0,
    defaultWeight: 30,
    available: true,
    drillPath: "/sales?filter=late-to-customer",
    roles: ["OFFICE", "SALES"],
  },
  {
    key: "setup_completeness",
    label: "Product master data completeness",
    detail: "Every active SKU carries the four things production and quoting need",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    purpose:
      "An SKU missing its price, volume, fabric usage or routing cannot be quoted, planned or costed. The gap surfaces later as a rush, a wrong price, or a job card nobody can schedule.",
    definition:
      "The share of ACTIVE products that have ALL FOUR of: a selling price, a cubic volume (m³), a fabric usage figure, and an ACTIVE BOM template that actually contains routing steps.",
    measurement: [
      "Count every product with status ACTIVE.",
      "A product counts as complete only when all four are present — price > 0, unit_m3 > 0, fabric_usage > 0, and an ACTIVE BOM template whose routing list is not empty.",
      "An empty BOM template counts as INCOMPLETE. 45% of templates on file have no routing in them, and the daily report has been reading those as fine.",
      "Score = complete ÷ active × 100.",
    ],
    formula: "Active SKUs having price + m³ + fabric usage + a BOM with routing ÷ all active SKUs × 100",
    defaultTarget: 95,
    defaultWeight: 20,
    available: true,
    drillPath: "/products?filter=incomplete",
    roles: ["OFFICE"],
  },
  {
    key: "documents_not_stuck",
    label: "Invoice raised within 3 days of dispatch",
    detail: "Each delivery order costs 10 points for every day its invoice is late",
    shape: "RATIO",
    direction: "LOWER_IS_BETTER",
    unit: "count",
    scoring: "AUTO",
    curve: "PENALTY_PER_UNIT",
    penaltyPerUnit: 10,
    graceDays: 3,
    purpose:
      "Goods that shipped but were never invoiced are work already paid for by us and not yet paid for by the customer. It is cash sitting still, and every day it sits is a day we financed the customer for free.",
    definition:
      "Days late, summed across every delivery order dispatched in the month. The clock starts the day the goods leave and the invoice is due within 3 days. The unit counted is the DELIVERY ORDER (or the invoice raised against it), NOT the sales order — several sales orders routinely ship on one delivery order, and that is one document to bill, not three.",
    measurement: [
      "For every delivery order dispatched during the month, take the date it left.",
      "Find the invoice raised against that delivery order. If there is none yet, count up to today instead.",
      "Days late = days from dispatch to invoice, minus the 3 allowed. Invoiced on day 0, 1, 2 or 3 is not late.",
      "Add up the days late across every delivery order. Five documents one day late each = 5, exactly the same as one document five days late.",
      "Score starts at 100 and loses 10 points per day late. 10 days late in total scores nothing.",
    ],
    formula: "100 − (total days late × 10), where a delivery order is late from day 4 after dispatch",
    defaultTarget: 0,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE"],
  },
  {
    key: "exceptions_cleared",
    label: "Daily exception backlog cleared",
    detail: "How much of the month's opening exception list actually got closed",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    purpose:
      "The daily report raises a few hundred exceptions a month — wrong prices, missing invoices, unreceived purchase orders. They are only useful if somebody works them down. This measures whether the list shrinks.",
    definition:
      "The share of the exceptions open at the START of the month that were closed by the END of it. It is a burn-down, not a snapshot.",
    measurement: [
      "Take the total exception count from the first daily snapshot stored in the month.",
      "Take the total from the last snapshot in the month.",
      "Cleared = opening − closing. A month that ends with MORE than it started scores 0 rather than a negative.",
      "Score = cleared ÷ opening × 100.",
    ],
    formula: "(Exceptions open at the start of the month − open at the end) ÷ open at the start × 100",
    defaultTarget: 90,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE", "QA"],
  },
  {
    key: "customer_satisfaction",
    label: "Customer satisfaction survey",
    detail: "Five questions, each scored 1–5 by the customer, worth 20 points each",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "SURVEY",
    curve: "SURVEY_MEAN",
    purpose:
      "We hear from customers only when something goes wrong, so the quiet ones are invisible until they leave. Asking a handful every month turns service quality into a number that moves.",
    definition:
      "Three customers a month answer five questions about how the office deals with them. Each answer is 1–5 and worth up to 20 points, so five 5s is 100 and four 5s with one 4 is 96. The KPI is the average across everyone who replied.",
    measurement: [
      "Pick about three customers and send each the five-question link. They may be the same customers as last month — what matters is that somebody is asked.",
      "Each question is answered 1–5. A 5 earns the full 20 points for that question, a 4 earns 16, a 3 earns 12, and so on.",
      "One reply's score = (sum of the five answers ÷ 25) × 100.",
      "The month's figure is the average across every reply received.",
      "That figure is the attainment, multiplied by the weight assigned. At weight 20, a 96 earns 19.2 points.",
    ],
    formula: "Average across replies of (sum of five 1–5 answers ÷ 25) × 100",
    surveyQuestions: [
      "When you send us an enquiry or ask for a quotation, how quickly do you get a reply?",
      "When you ask where your order is or when it will arrive, how clear and reliable is the answer?",
      "When you chase us or follow up, how quickly does someone come back to you?",
      "How accurate is the paperwork we send you — quotations, order confirmations, delivery notes and invoices?",
      "When something went wrong, how well did we own it and put it right?",
    ],
    defaultTarget: 90,
    defaultWeight: 20,
    available: true,
    roles: ["OFFICE"],
  },
  {
    key: "problems_caught_early",
    label: "Problems raised early — before they grew",
    detail: "Rated by your supervisor at month end. Not counted by the system",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "score",
    scoring: "MANUAL",
    curve: "MANUAL_SCORE",
    purpose:
      "Most of the work is done by agents now, so the job is watching them. The cost of a missed exception is not the exception — it is the customer finding it first. Catching something early and killing it while it is small is worth more than handling it well after it has grown.",
    definition:
      "A score out of 100, given by your supervisor at the end of the month. This is the one KPI the system does NOT calculate, because it cannot: a month with genuinely nothing wrong and a month where nobody looked produce the same empty record. Only a supervisor can tell those apart, and usually only afterwards.",
    measurement: [
      "During the month, raise the problems you find — before they turn into a customer complaint, a delay or a loss.",
      "At month end your supervisor scores this out of 100 and writes the reason.",
      "Finding nothing because there genuinely was nothing is fine and does not cost you marks.",
      "Raising nothing, and then something going wrong that was there to be found, scores low. That is the case this KPI exists for.",
      "The score and the supervisor's note are both shown on your card, so you know why.",
    ],
    formula: "Your supervisor's score out of 100, multiplied by this KPI's weight",
    ratingGuide: [
      "90–100 — caught something real and early, and it was killed while it was still small.",
      "70–89 — raised problems in good time; nothing serious got past.",
      "50–69 — quiet month, nothing raised, and nothing blew up either.",
      "1–49 — nothing was raised, and something then went wrong that was findable.",
    ],
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    roles: ["OFFICE", "QA", "SALES", "HR", "FINANCE", "PRODUCTION", "WAREHOUSE"],
  },
];

export function kpiByKey(key: string): KpiDef | undefined {
  return KPI_CATALOG.find((k) => k.key === key);
}

export function kpisForRole(role: string): KpiDef[] {
  const r = (role || "").toUpperCase();
  return KPI_CATALOG.filter((k) => k.roles.includes(r));
}

/**
 * Attainment as a percentage of target, capped at 120.
 *
 * Capped because an uncapped ratio lets one runaway metric paper over a
 * failure elsewhere — 300% on the easy one would cancel 0% on the hard one.
 * Floored at 0 so a bad month cannot produce negative points.
 */
export function attainment(
  def: Pick<KpiDef, "direction"> &
    Partial<Pick<KpiDef, "curve" | "penaltyPerPct" | "penaltyPerUnit">>,
  target: number,
  actual: number,
): number {
  if (!Number.isFinite(actual)) return 0;

  // Straight penalty off a perfect start. Used where the target is zero and a
  // ratio would divide by it.
  if (def.curve === "PENALTY_PER_PCT") {
    const per = Number(def.penaltyPerPct) || 10;
    return Math.max(0, Math.min(120, Math.round((100 - actual * per) * 10) / 10));
  }
  // Same shape, but the actual is a COUNT (document-days late) rather than a
  // percentage, so nothing is normalised by a denominator first.
  if (def.curve === "PENALTY_PER_UNIT") {
    const per = Number(def.penaltyPerUnit) || 10;
    return Math.max(0, Math.min(120, Math.round((100 - actual * per) * 10) / 10));
  }
  // A survey mean, and a supervisor's rating, are both already the attainment.
  if (def.curve === "SURVEY_MEAN" || def.curve === "MANUAL_SCORE") {
    return Math.max(0, Math.min(120, Math.round(actual * 10) / 10));
  }

  if (!Number.isFinite(target)) return 0;
  if (def.direction === "HIGHER_IS_BETTER") {
    if (target <= 0) return actual > 0 ? 120 : 0;
    return Math.max(0, Math.min(120, Math.round((actual / target) * 1000) / 10));
  }
  // LOWER_IS_BETTER: hitting target = 100%, and it degrades from there.
  if (actual <= target) return Math.min(120, target === 0 ? 100 : 100);
  if (target <= 0) return 0;
  return Math.max(0, Math.round((target / actual) * 1000) / 10);
}


/** How a person's KPI score turns into money, if at all. */
export type PayoutMode = "MONTHLY_CASH" | "SCORE_ONLY";

/**
 * One rung of the ladder.
 *
 * A rung pays EITHER a percentage of the pot or a flat sum. Owner 2026-08-06:
 * "can by amount also can by %". Both are in use in practice — a percentage
 * scales when the pot is reviewed, a flat sum is what people actually
 * negotiate ("hit 80 and you get RM 800"). `payAmountSen` wins when set, so a
 * rung can be pinned without disturbing the others.
 */
export interface PayoutBand {
  minScore: number;
  payPct: number;
  /** Flat sum for this rung, in sen. Overrides payPct when set. */
  payAmountSen?: number | null;
}

/**
 * The default ladder.
 *
 * Banded rather than straight-line, and deliberately so. A linear scale gives
 * nobody a reason to push 74 to 76 — two more points is two more percent of
 * the pot. A band means 79 → 80 jumps a whole rung, 60% to 80%, which is where
 * the pull comes from. The cliff at each boundary is the mechanism, not a
 * side effect.
 *
 * Below 60 pays nothing. Owner 2026-08-06: "如果是 50 分的话，是不是就直接拿不
 * 到了?" — yes. A straight line would pay 30% of the pot for a 30% month, and
 * that reads as a reward for missing.
 *
 * Ordered high to low; the first rung the score reaches wins.
 */
export const DEFAULT_PAYOUT_BANDS: PayoutBand[] = [
  { minScore: 90, payPct: 100 },
  { minScore: 80, payPct: 80 },
  { minScore: 70, payPct: 60 },
  { minScore: 60, payPct: 40 },
];

export interface PayoutSettings {
  mode: PayoutMode;
  /** The pot at the top band, in sen. */
  amountSen: number;
  /** Rungs, high to low. Empty falls back to DEFAULT_PAYOUT_BANDS. */
  bands: PayoutBand[];
}

export const DEFAULT_PAYOUT: PayoutSettings = {
  mode: "SCORE_ONLY",
  amountSen: 0,
  bands: DEFAULT_PAYOUT_BANDS,
};

/** The rung a score lands on, or null when it is below them all. */
export function bandFor(
  score: number | null,
  bands: PayoutBand[] = DEFAULT_PAYOUT_BANDS,
): PayoutBand | null {
  if (score === null || !Number.isFinite(score)) return null;
  // Fall back on an EMPTY list exactly as payoutSen does. A default parameter
  // only covers `undefined`, so an explicit [] slipped through here while the
  // money fell back — the card would have said "below the lowest band" beside
  // a full payout. The two must answer from the same ladder.
  const use = bands.length ? bands : DEFAULT_PAYOUT_BANDS;
  const ordered = [...use].sort((a, b) => b.minScore - a.minScore);
  return ordered.find((b) => score >= b.minScore) ?? null;
}

/**
 * What the month pays.
 *
 * SCORE_ONLY always returns 0 — the score still exists, it is simply not money
 * this month; the owner settles those at year end.
 */
export function payoutSen(score: number | null, s: PayoutSettings): number {
  if (s.mode !== "MONTHLY_CASH") return 0;
  const band = bandFor(score, s.bands?.length ? s.bands : DEFAULT_PAYOUT_BANDS);
  if (!band) return 0;
  // A flat rung stands on its own — it does not need a pot behind it, which is
  // the point of pinning one.
  if (band.payAmountSen != null && Number.isFinite(band.payAmountSen)) {
    return Math.max(0, Math.round(band.payAmountSen));
  }
  if (s.amountSen <= 0) return 0;
  return Math.round((s.amountSen * band.payPct) / 100);
}

/** What a rung is worth, for display. */
export function bandValueSen(band: PayoutBand, potSen: number): number {
  if (band.payAmountSen != null && Number.isFinite(band.payAmountSen)) {
    return Math.max(0, Math.round(band.payAmountSen));
  }
  return Math.round((potSen * band.payPct) / 100);
}
