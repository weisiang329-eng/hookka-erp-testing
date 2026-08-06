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

export type KpiShape = "GATE" | "RATIO";

/**
 * How the ACTUAL number is produced.
 *
 *   AUTO      — computed from data already in the system.
 *   CHECKLIST — a fixed list of actions defined here, ticked during the month
 *               and verified by Super Admin. actual = done ÷ total.
 *
 * There is deliberately no subjective "rated" type. Owner 2026-08-06: "每一个
 * KPI 都必须是可以量化的，员工怎么去达成、做到什么程度能拿多少分 … 全部都要有
 * 明确、可衡量的标准." A score somebody assigns by impression at month end
 * cannot be worked towards, so it is not a KPI — it is an opinion with a
 * number on it. Anything that felt un-measurable is expressed as a checklist
 * of the ACTIONS instead, which is countable and knowable in advance.
 */
export type KpiScoring = "AUTO" | "CHECKLIST";
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

/** Below this, a missed gate caps the total score. */
export const GATE_FAIL_CAP = 60;

export const KPI_CATALOG: KpiDef[] = [
  {
    key: "customer_delivery_date",
    label: "On-time delivery to the customer's promised date",
    detail: "Zero tolerance — the promised date is the floor, not a target",
    shape: "GATE",
    direction: "LOWER_IS_BETTER",
    unit: "count",
    scoring: "AUTO",
    purpose:
      "A late delivery is the one failure the customer always notices. Everything else in the factory can slip; this cannot.",
    definition:
      "The number of SALES ORDERS whose FIRST dispatch left after the delivery date promised to that customer. Counted once per order, not per delivery note — a customer promised one date was let down once, however many trips it took.",
    measurement: [
      "Take the date on the sales order that was promised to the customer (customer_delivery_date, filled on 99.8% of orders). Our own internal estimate is NOT used.",
      "Find the first dispatch date across every delivery order carrying that sales order's production.",
      "If the dispatch date is later than the promised date, the order counts as late.",
      "Target is 0. Any late order fails the gate and caps the whole month's score at 60.",
    ],
    formula: "Count of sales orders dispatched after the date promised to the customer. Target 0.",
    defaultTarget: 0,
    defaultWeight: 0,
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
    label: "Orders billed, not left sitting",
    detail: "Delivered goods that still have no invoice against them",
    shape: "RATIO",
    direction: "LOWER_IS_BETTER",
    unit: "count",
    scoring: "AUTO",
    purpose:
      "Goods that shipped but were never invoiced are work already paid for by us and not yet paid for by the customer. It is the largest single item on the daily report and it is cash sitting still.",
    definition:
      "The count of sales orders and delivery orders that have moved but carry no invoice — the same two buckets the Daily Report shows on the dashboard.",
    measurement: [
      "Read the Daily Report's own figures rather than asking the question separately, so this KPI and the dashboard can never disagree.",
      "Add: sales orders not yet invoiced + delivery orders not yet invoiced.",
      "Lower is better. Reaching the target scores full marks; there is no extra credit for going below it.",
    ],
    formula: "Sales orders not invoiced + delivery orders not invoiced, from the Daily Report on the dashboard",
    defaultTarget: 40,
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
    label: "Customer satisfaction survey — 3 customers a month",
    detail: "Pick three, send the link, collect the scores, act on the low ones",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "CHECKLIST",
    purpose:
      "We hear from customers only when something goes wrong, which means the quiet ones are invisible until they leave. Asking three a month, rotating through the list, turns that into a number that moves.",
    definition:
      "A monthly cycle: choose three customers who were NOT surveyed last month, send each a scored questionnaire, collect the replies, and turn anything below 3/5 into a written improvement item. Scored on completing the cycle, not on the customers' mood — the mood is theirs, the follow-through is ours.",
    measurement: [
      "Pick 3 customers who did not receive the survey last month (rotate, so the same easy accounts are not asked every time).",
      "Send each the questionnaire link. Five questions, each scored 1–5: delivery on time · product quality · quotation accuracy · how quickly we answer · how easy we are to deal with.",
      "Collect at least 2 replies. Below that the month's answers are too thin to read.",
      "Any answer below 3/5 becomes a written improvement item with an owner.",
      "Score = items completed ÷ 4 × 100. When the survey system ships, the AVERAGE SCORE joins as a separate KPI — this one keeps measuring that the cycle was run.",
    ],
    formula: "Steps of the monthly survey cycle completed ÷ 4 × 100",
    checklistItems: [
      "3 customers chosen, none of them surveyed last month",
      "Survey link sent to all 3",
      "At least 2 replies received",
      "Every answer below 3/5 written up as an improvement item with an owner",
    ],
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    roles: ["OFFICE"],
  },
  {
    key: "problems_caught_early",
    label: "Preventive sweep — find it before the customer does",
    detail: "Five checks a month over the places trouble shows up first",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "CHECKLIST",
    purpose:
      "Most of the work is done by agents now, so the job is watching them. The cost of a missed exception is not the exception — it is the customer finding it first.",
    definition:
      "Five named checks, each done at least once in the month and verified by Super Admin. Scored on the checks being done, because whether a problem existed that month is luck; whether anyone looked is not.",
    measurement: [
      "Each of the five checks is ticked by the person when done, and verified by Super Admin.",
      "A tick is a claim; the verification is what makes it a score. Super Admin can untick.",
      "Score = checks done ÷ 5 × 100.",
      "The list is fixed in the system, so it cannot be shortened to raise a score.",
    ],
    formula: "Checks completed ÷ 5 × 100",
    checklistItems: [
      "Agent error log reviewed and every failed run raised",
      "Orders already past their promised date reviewed and chased",
      "Price and COGS anomalies on the daily report cleared",
      "Purchase orders not yet received chased with the supplier",
      "Delivered orders with no invoice pushed through to billing",
    ],
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    roles: ["OFFICE", "QA"],
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
  def: Pick<KpiDef, "direction">,
  target: number,
  actual: number,
): number {
  if (!Number.isFinite(target) || !Number.isFinite(actual)) return 0;
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

/** One rung: score at or above `minScore` pays `payPct` of the pot. */
export interface PayoutBand {
  minScore: number;
  payPct: number;
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
  if (s.amountSen <= 0) return 0;
  const band = bandFor(score, s.bands?.length ? s.bands : DEFAULT_PAYOUT_BANDS);
  if (!band) return 0;
  return Math.round((s.amountSen * band.payPct) / 100);
}
