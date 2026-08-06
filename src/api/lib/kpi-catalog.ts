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
 *   COMPOSITE          — the metric already blended two or more halves and
 *                        handed back a finished 0–100 score.
 *   EFFICIENCY_BANDS   — piecewise, and steep below the floor. Owner
 *                        2026-08-07: "达到 80%：基本上还能拿得到 60 分 … 低于
 *                        80%（可能在 75% 之下）：直接 0 分." A straight ratio
 *                        would pay 80 points for 80% efficiency, which reads as
 *                        "80% is a B". It is not — it is the floor, and five
 *                        points below it the work is not worth costing.
 *
 * SURVEY_MEAN, MANUAL_SCORE and COMPOSITE are all pass-throughs. They stay
 * separate names because the
 * card explains itself differently for each, and because collapsing them would
 * make "why is this not divided by the target?" unanswerable.
 */
export type AttainmentCurve =
  | "TARGET_RATIO"
  | "PENALTY_PER_PCT"
  | "PENALTY_PER_UNIT"
  | "SURVEY_MEAN"
  | "MANUAL_SCORE"
  | "COMPOSITE"
  | "EFFICIENCY_BANDS";
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
  /**
   * SURVEY only — what 1 through 5 MEAN, index 0 = 1 star.
   *
   * Owner 2026-08-07: "最高是 Excellent，最小是 Poor，中间是 Acceptable，第四个
   * 是？" A bare 1–5 gets answered differently by every customer — some treat 3
   * as "fine", others as a complaint — and an average across those is not a
   * measurement of anything. Naming each rung makes the replies comparable.
   */
  surveyScale?: string[];
  curve?: AttainmentCurve;
  /** PENALTY_PER_PCT only — points lost per percentage point. */
  penaltyPerPct?: number;
  /** PENALTY_PER_UNIT only — points lost per whole unit of the actual. */
  penaltyPerUnit?: number;
  /** How many days are allowed before a document starts counting as late. */
  graceDays?: number;
  /** EFFICIENCY_BANDS — the floor, what it scores, and where the score hits 0. */
  efficiencyFloorPct?: number;
  efficiencyFloorScore?: number;
  efficiencyZeroPct?: number;
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
      "Score = complete ÷ active × 100. Everything present is 100; the score IS the share finished, so 80 means four SKUs in five are fully set up.",
      "The card also lists how many SKUs are missing EACH field, because 'we are at 31%' cannot be acted on and '247 have no BOM' can.",
      "WIP times are deliberately NOT part of this. They belong to production routing, not to the product record, and the daily report already tracks them separately.",
      "Sectional COMPONENTS count. 86 active SOFA SKUs (5545-1A(LHF), 5543-CSL and the like) are pieces of a set rather than something sold on its own, and all 86 carry no price, no volume, no fabric usage and no routing — they are the whole of the gap. Owner 2026-08-07 ruled they stay in: a piece we cut, sew and ship needs its own figures whether or not a customer can buy it alone.",
    ],
    formula: "Active SKUs having price + m³ + fabric usage + a BOM with routing ÷ all active SKUs × 100",
    // 100, not 95. Owner 2026-08-07: "everything 都有就代表 100 分，然后看他完成
    // 多少" — the score should BE the share finished. Against a target of 95 a
    // genuine 31.4% reported as 33.1, which is a different number for no reason
    // anyone could explain.
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    drillPath: "/products?filter=incomplete",
    roles: ["OFFICE"],
  },
  {
    key: "documents_not_stuck",
    label: "Daily report worked down — invoices raised, exceptions cleared",
    detail: "Invoice within 3 days of dispatch, and burn down the rest of the list",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "score",
    scoring: "AUTO",
    curve: "COMPOSITE",
    penaltyPerUnit: 10,
    graceDays: 3,
    purpose:
      "Goods that shipped but were never invoiced are work already paid for by us and not yet paid for by the customer — cash sitting still, and every day it sits is a day we financed the customer for free. The rest of the daily report is the same job in a different column: a few hundred exceptions a month that are only worth raising if somebody works them down.",
    definition:
      "One score out of 100 from two halves, worth 50 each. Owner 2026-08-07: these were two KPIs and they are now one, because uninvoiced deliveries were ALSO one of the daily-report exception categories — the same failure was being charged twice. The exception half now excludes the invoice buckets, so nothing is double-counted.",
    measurement: [
      "HALF ONE — invoicing, 50 points. For every delivery order dispatched during the month, measure the days from dispatch to the invoice raised against it. No invoice yet counts up to today.",
      "3 days are allowed. Days late = the gap minus 3; invoiced on day 0–3 is not late.",
      "Add up the days late across every delivery order. Five documents one day late each = 5, the same as one document five days late — the unit is the DELIVERY ORDER, not the sales order, because several orders routinely ship on one document and billing it late is one failure, not three.",
      "That half starts at 100 and loses 10 points per day late; 10 days late scores nothing.",
      "HALF TWO — the rest of the list, 50 points. Take the exception total from the first daily snapshot in the month and from the last, EXCLUDING the uninvoiced buckets already scored above. Score = cleared ÷ opening × 100.",
      "The two halves are averaged. A half with no data to score is dropped and the other stands alone, rather than being counted as a zero.",
    ],
    formula:
      "Average of: [100 − days late × 10] and [exceptions cleared ÷ exceptions open at the start × 100, invoice buckets excluded]",
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE"],
  },
  {
    key: "production_efficiency",
    label: "Production time efficiency",
    detail: "Standard minutes earned against production hours worked. 100% is the norm",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    curve: "EFFICIENCY_BANDS",
    efficiencyFloorPct: 80,
    efficiencyFloorScore: 60,
    efficiencyZeroPct: 75,
    purpose:
      "Every hour a production worker is paid for is an hour we quoted against a standard time. When the floor runs below its standard, the difference is not a number in a report — it is work we sold at one price and paid for at another.",
    definition:
      "The standard minutes earned by completed job cards, divided by the hours actually worked in production departments, as a percentage. 100% means the floor produced exactly what the BOM said the work should take. This is the SAME figure the efficiency allowance and the daily report already use, so a worker's payslip and this KPI can never disagree.",
    measurement: [
      "Earned minutes: every job card completed or transferred in the month, valued at its BOM standard time. A card with two people on it splits the credit.",
      "Worked hours: hours logged against production departments only. Office and admin hours are not in the denominator.",
      "Efficiency % = earned minutes ÷ (worked hours × 60) × 100.",
      "100% or better scores the full 100 points. There is no bonus above 100 — beating the standard usually means the standard is wrong, not that the month was twice as good.",
      "80% is the FLOOR and scores 60. Between 80% and 100% the score rises 2 points for every 1% of efficiency: 85% → 70, 90% → 80, 95% → 90.",
      "Below the floor it falls away fast: 78% → 36, 76% → 12, and 75% or under scores 0. Work costed at 75% of its standard time is not work we can price.",
    ],
    formula:
      "100% → 100 pts · 90% → 80 · 80% → 60 (the floor) · 78% → 36 · 75% or below → 0",
    defaultTarget: 100,
    defaultWeight: 30,
    available: true,
    drillPath: "/reports/operations",
    roles: ["PRODUCTION", "QA"],
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
      "Each question is answered 1–5, and every rung is named so two customers mean the same thing by a 3: 5 Excellent, 4 Good, 3 Acceptable, 2 Weak, 1 Poor.",
      "A 5 earns the full 20 points for that question, a 4 earns 16, a 3 earns 12, a 2 earns 8, a 1 earns 4.",
      "Note that 'Acceptable' is a 60, not a pass mark of 100. A customer who is simply not complaining is not a customer who is happy.",
      "One reply's score = (sum of the five answers ÷ 25) × 100.",
      "The month's figure is the average across every reply received.",
      "That figure is the attainment, multiplied by the weight assigned. At weight 20, a 96 earns 19.2 points.",
    ],
    formula: "Average across replies of (sum of five 1–5 answers ÷ 25) × 100",
    // Q1 was "how quickly do you get a quotation" until 2026-08-07. The owner
    // struck it: quoting is Sales' job, and scoring Office on somebody else's
    // response time measures the wrong department. The replacement is
    // deliberately OPEN — the other four are all specific, so one broad
    // question is where a complaint the questionnaire never thought to ask
    // about can still land.
    surveyQuestions: [
      "When you ask where your order is or when it will arrive, how clear and reliable is the answer?",
      "When you chase us or follow up, how quickly does someone come back to you?",
      "How accurate is the paperwork we send you — order confirmations, delivery notes and invoices?",
      "When something went wrong, did you hear it from us first, and did someone stay on it until it was closed?",
      "Overall, how easy are we to deal with as a supplier?",
    ],
    // Index 0 is a 1. Deliberately NOT symmetrical in tone: 3 is "Acceptable",
    // which is a pass and not a compliment, so a customer who is merely not
    // complaining lands at 60 rather than at the middle of a happy scale.
    surveyScale: [
      "Poor — it caused me a real problem",
      "Weak — below what I expect from you",
      "Acceptable — it was fine, nothing more",
      "Good — better than most suppliers I deal with",
      "Excellent — I could not ask for better",
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
      "At month end your supervisor scores this out of 100 against the bands below, and writes the reason.",
      "A NORMAL month is 60–69. Nothing raised and nothing went wrong is a pass, not a failure — this KPI does not reward inventing problems to report.",
      "You go ABOVE 80 by catching something real while it was still cheap to fix. Two things earn the marks: that it was genuine, and that it was early.",
      "You go BELOW 50 only when something went wrong that was there to be found and nobody raised it. Being unlucky is not scored; not looking is.",
      "It is judged on what you RAISED, not on what you personally fixed. Passing a problem to the right person in time counts fully.",
      "The score and the supervisor's note are both shown on your card, so you can see the reason and argue with it.",
    ],
    formula: "Your supervisor's score out of 100, multiplied by this KPI's weight",
    ratingGuide: [
      "90–100 — Caught something that would have cost us. Raised it while it was still cheap to fix, and it never reached the customer. Example: spotted that a fabric on three open orders was short before cutting started, so the orders were re-planned instead of stopping the line.",
      "80–89 — Consistently ahead of the problems. Several real issues raised during the month, each early enough that handling them was routine rather than urgent. Nothing needed rescuing.",
      "70–79 — Solid. Problems were raised, but mostly once they were already visible to someone else. Nothing got worse for being noticed late.",
      "60–69 — The ordinary quiet month. Nothing significant raised, and nothing went wrong. This is the DEFAULT, not a punishment — a month with genuinely nothing to find lands here.",
      "50–59 — Nothing raised, and afterwards something surfaced that was awkward but small: a document nobody chased, a price nobody queried. Findable, but it cost us little.",
      "30–49 — Nothing raised, and something then went wrong that was clearly there to be found. The information was on a screen this person looks at.",
      "1–29 — Something was noticed and not passed on, or was raised only once the customer had already complained. This band is for withholding, not for missing.",
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
    Partial<
      Pick<
        KpiDef,
        | "curve"
        | "penaltyPerPct"
        | "penaltyPerUnit"
        | "efficiencyFloorPct"
        | "efficiencyFloorScore"
        | "efficiencyZeroPct"
      >
    >,
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
  // A survey mean, a supervisor's rating and a blended score are all already
  // the attainment.
  // Piecewise: full marks at 100%, the floor scores its stated points, and it
  // falls to nothing a few points below. Two straight lines, not a ratio.
  if (def.curve === "EFFICIENCY_BANDS") {
    const floor = Number(def.efficiencyFloorPct ?? 80);
    const floorScore = Number(def.efficiencyFloorScore ?? 60);
    const zero = Number(def.efficiencyZeroPct ?? 75);
    if (actual >= 100) return 100;
    if (actual >= floor) {
      const slope = (100 - floorScore) / (100 - floor);
      return Math.round((floorScore + (actual - floor) * slope) * 10) / 10;
    }
    if (actual > zero) {
      return Math.round(((actual - zero) / (floor - zero)) * floorScore * 10) / 10;
    }
    return 0;
  }
  if (
    def.curve === "SURVEY_MEAN" ||
    def.curve === "MANUAL_SCORE" ||
    def.curve === "COMPOSITE"
  ) {
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
