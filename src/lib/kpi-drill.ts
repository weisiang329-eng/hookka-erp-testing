// ---------------------------------------------------------------------------
// kpi-drill.ts — the "See the list →" contract, shared by the KPI card and by
// every page that link lands on.
//
// The owner's rule (2026-08-07): "如果是 showable 的话，就要确保这些全部数据是可
// 以被看到的" — if the card shows a link, the rows behind the number have to be
// reachable. A link that opens the UNFILTERED list is worse than no link: the
// number said 11 and the page shows 348, so either the number is wrong or the
// page is, and the reader has no way to tell which.
//
// Two halves live here:
//
//  1. `drillHref` — the card stamps the month it is showing into the URL. A
//     drill-down without the period would open "all late orders ever", which
//     is a different set from the one the card counted.
//
//  2. the pure predicates each landing page applies. They are here, not inline
//     in the page, so the regression test can prove the param NARROWS the set
//     without booting a browser — and so the predicate reads next to the
//     metric it mirrors.
//
// Anything that needs a server join (first-dispatch dates, BOM templates) is
// NOT reimplemented here — those pages fetch the id list from an endpoint that
// shares its SQL with the metric, and use `narrowToIds` below. Re-deriving a
// join in the browser is how a list starts disagreeing with its number.
// ---------------------------------------------------------------------------

/** Substituted with the card's month when the link is built. */
export const PERIOD_TOKEN = "{period}";

/**
 * The href for a KPI card's drill-down link.
 *
 * A `drillPath` carrying `{period}` is month-scoped and gets the card's month;
 * one without it is a point-in-time list (product master data is "right now",
 * not "in July") and is left alone. Making every link carry a period would put
 * a parameter on the Products URL that nothing reads — which is the same lie
 * in a smaller font.
 */
export function drillHref(drillPath: string, period: string): string {
  if (!drillPath.includes(PERIOD_TOKEN)) return drillPath;
  return drillPath.split(PERIOD_TOKEN).join(encodeURIComponent(period));
}

/** First and last day of a YYYY-MM period, inclusive. */
export function periodBounds(period: string): { start: string; end: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${period}-01`, end: `${period}-${String(last).padStart(2, "0")}` };
}

/** A YYYY-MM that is safe to put in a query string, or "" when it is not one. */
export function validPeriod(v: string | null | undefined): string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : "";
}

/**
 * Keep only the rows whose id the server said belong to the drill-down.
 *
 * `ids` null means "not loaded yet" and leaves the list ALONE rather than
 * blanking it — a page that flashes empty while a fetch is in flight looks
 * like a broken filter. An empty set is a real answer (nothing was late) and
 * does narrow to nothing.
 *
 * Narrowing an already-scoped list can only ever REMOVE rows, so this cannot
 * reveal anything the API did not already send. The id list itself is scoped
 * server-side (src/api/lib/customer-scope.ts).
 */
export function narrowToIds<T extends { id: string }>(
  rows: T[],
  ids: ReadonlySet<string> | null,
): T[] {
  if (ids === null) return rows;
  return rows.filter((r) => ids.has(r.id));
}

/**
 * The service cases `serviceCaseResolution` averages for a month.
 *
 * Mirrors the metric's WHERE clause exactly (src/api/lib/kpi-metrics.ts):
 * every case CLOSED inside the month, plus every case still open that was
 * raised on or before the month ended. The open ones are in the average
 * deliberately — scoring only closures would make "never close it" the
 * highest-scoring strategy available.
 *
 * Dates are compared as YYYY-MM-DD strings, same as the SQL's substr(...,1,10).
 */
export function serviceCaseCountedIn(
  row: { createdAt?: string | null; closedAt?: string | null },
  period: string,
): boolean {
  const { start, end } = periodBounds(period);
  const raised = ymd(row.createdAt);
  if (!raised) return false;
  const closed = ymd(row.closedAt);
  if (closed) return closed >= start && closed <= end;
  return raised <= end;
}

function ymd(v: string | null | undefined): string {
  if (typeof v !== "string") return "";
  const s = v.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** The four things `setup_completeness` requires of an ACTIVE SKU. */
export const SETUP_FIELD_LABEL = {
  price: "price",
  volume: "volume (m³)",
  fabric: "fabric usage",
  bom: "BOM routing",
} as const;

export type SetupField = keyof typeof SETUP_FIELD_LABEL;

export function isSetupField(v: unknown): v is SetupField {
  return typeof v === "string" && v in SETUP_FIELD_LABEL;
}
