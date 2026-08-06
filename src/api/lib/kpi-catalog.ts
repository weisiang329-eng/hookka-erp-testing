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
    label: "Customer delivery date",
    detail: "Orders shipped on or before the date promised to the customer",
    shape: "GATE",
    direction: "LOWER_IS_BETTER",
    unit: "count",
    scoring: "AUTO",
    formula:
      "Orders whose first dispatch was after the date promised to the customer. Target is 0 — any miss caps the whole score.",
    defaultTarget: 0,
    defaultWeight: 0,
    available: true,
    drillPath: "/sales?filter=late-to-customer",
    roles: ["OFFICE", "SALES"],
  },
  {
    key: "setup_completeness",
    label: "Setup completeness",
    detail: "Active SKUs with a price, m³, fabric usage and a BOM that has routing",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    formula:
      "Active SKUs having ALL of: a price, a cubic volume, a fabric usage and an ACTIVE BOM that contains routing ÷ all active SKUs × 100",
    defaultTarget: 95,
    defaultWeight: 20,
    available: true,
    drillPath: "/products?filter=incomplete",
    roles: ["OFFICE"],
  },
  {
    key: "documents_not_stuck",
    label: "Documents not stuck",
    detail: "Sales order → delivery order → invoice, open more than 7 days",
    shape: "RATIO",
    direction: "LOWER_IS_BETTER",
    unit: "count",
    scoring: "AUTO",
    formula:
      "Sales orders not yet invoiced + delivery orders not yet invoiced, taken from the same Daily Report you see on the dashboard",
    defaultTarget: 40,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE"],
  },
  {
    key: "exceptions_cleared",
    label: "Exceptions cleared",
    detail: "Daily-report exceptions closed within the same week",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "AUTO",
    formula:
      "(Exceptions open at the start of the month − open at the end) ÷ open at the start × 100",
    defaultTarget: 90,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE", "QA"],
  },
  {
    // Measures the ACTIONS, not the customer's mood. The mood needs a survey
    // that does not exist; the actions are countable today and are what the
    // person actually controls. When the survey ships, an average-score KPI
    // joins this one as AUTO rather than replacing it.
    key: "customer_satisfaction",
    label: "Customer satisfaction follow-up",
    detail: "Reaching out, collecting replies and acting on the low ones",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "CHECKLIST",
    formula: "Items completed ÷ items in the list × 100",
    checklistItems: [
      "Satisfaction link sent to at least 3 customers",
      "At least 2 replies collected",
      "Any reply below 3/5 written up as an improvement item",
      "Last month's improvement items followed up",
    ],
    defaultTarget: 100,
    defaultWeight: 20,
    available: true,
    roles: ["OFFICE"],
  },
  {
    key: "problems_caught_early",
    label: "Problems caught early",
    detail: "The monthly sweep that finds trouble before the customer does",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    scoring: "CHECKLIST",
    formula: "Items completed ÷ items in the list × 100",
    checklistItems: [
      "Agent error log reviewed and failures raised",
      "Orders past their customer date reviewed and chased",
      "Price and COGS anomalies on the daily report cleared",
      "Purchase orders not received chased with the supplier",
      "Stuck delivery orders pushed to invoice",
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
