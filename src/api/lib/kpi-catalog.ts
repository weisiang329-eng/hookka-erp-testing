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
  /** Suggested target; the assignment row overrides it per person. */
  defaultTarget: number;
  /** Suggested weight (RATIO only; a GATE has none — it caps). */
  defaultWeight: number;
  /** False until the capture it needs exists. */
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
    defaultTarget: 90,
    defaultWeight: 20,
    available: true,
    drillPath: "/daily-report",
    roles: ["OFFICE", "QA"],
  },
  {
    key: "customer_satisfaction",
    label: "Customer satisfaction",
    detail: "3–5 customers surveyed each month, average score",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "score",
    defaultTarget: 4,
    defaultWeight: 20,
    available: false,
    blockedBy:
      "No survey exists yet — needs a response table, a tokenised public link and a send step.",
    roles: ["OFFICE"],
  },
  {
    key: "problems_caught_early",
    label: "Problems caught early",
    detail: "Exceptions acknowledged before they reach the customer",
    shape: "RATIO",
    direction: "HIGHER_IS_BETTER",
    unit: "%",
    defaultTarget: 80,
    defaultWeight: 20,
    available: false,
    blockedBy:
      "Nothing records who saw an exception or when — needs an acknowledgement trail.",
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
