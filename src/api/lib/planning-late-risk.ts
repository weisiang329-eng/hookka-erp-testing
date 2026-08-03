// ---------------------------------------------------------------------------
// planning-late-risk.ts — which orders the plan CANNOT deliver on time, said
// today instead of on the day.
//
// The scheduler has always been able to produce a date past the customer's
// delivery date; it simply had no notion that this was a failure, so a late
// order looked exactly like an on-time one until it went overdue. Owner
// 2026-08-03: "如果你发现排着排着真的会迟送货，就只能开 OT 了。但你必须提前开."
// Opening overtime early is only possible if the lateness is known early.
//
// This module runs the SAME engine the Planning pages and the Production
// Agent's proposals use (computeChainWithAssignments), takes each order's LAST
// scheduled operation, and compares it against the promise minus a dispatch
// buffer. Anything that cannot fit is reported with how many working days it
// misses by and which department it finishes in — the input the morning brief
// needs to say "start OT now" or "call this customer today".
//
// Read-only. Nothing here writes, and it deliberately reuses the engine rather
// than re-deriving dates, so this report can never disagree with the schedule
// the floor is working to.
// ---------------------------------------------------------------------------

import { computeChainWithAssignments } from "../routes/planning-schedule";
import { DEFAULT_SHIP_BUFFER_DAYS } from "./planning-deadlines";
import { loadHolidaySet } from "./agent-learning";

// Deliberately WITHOUT `run` — this module only reads, and saying so in the
// type means a write cannot be added here without the change being obvious.
// The one collaborator that wants a wider handle (loadHolidaySet) is given a
// widened view at the call site rather than widening this contract.
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

type WiderDb = Parameters<typeof loadHolidaySet>[0];

export interface LateOrder {
  /** companySOId (or salesOrderId when the SO carries no company reference). */
  soId: string;
  customer: string;
  /** The customer's delivery date, YYYY-MM-DD. */
  customerDd: string;
  /** Last working day the plan may finish on and still ship in time. */
  deadline: string;
  /** The engine's last scheduled operation for this order. */
  scheduledFinish: string;
  /** Department that finishing operation belongs to. */
  finishDept: string;
  /** WORKING days past the deadline. Always ≥ 1 for a row in this list. */
  workingDaysLate: number;
  /** Job cards behind the slip — the work that would need overtime. */
  cards: number;
}

export interface LateRiskReport {
  generatedAt: string;
  shipBufferDays: number;
  /** Orders the current plan cannot deliver on time, worst first. */
  late: LateOrder[];
  /** Orders scheduled to finish on the deadline itself — no room left. */
  atRisk: LateOrder[];
  /** Orders in the plan carrying no customer date, so nothing to measure. */
  undated: number;
  totalOrdersPlanned: number;
}

/** Working-day step used for the dispatch buffer (Sundays + holidays off). */
function backWorkingDays(ymd: string, n: number, holidays: Set<string>): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  let stepped = 0;
  let guard = 0;
  while (stepped < n && guard < n * 5 + 30) {
    d.setUTCDate(d.getUTCDate() - 1);
    guard++;
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && !holidays.has(iso)) stepped++;
  }
  return d.toISOString().slice(0, 10);
}

/** Whole working days from `from` to `to`, exclusive of `from`. */
function workingDaysBetween(from: string, to: string, holidays: Set<string>): number {
  if (to <= from) return 0;
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let n = 0;
  let guard = 0;
  while (d < end && guard < 2000) {
    d.setUTCDate(d.getUTCDate() + 1);
    guard++;
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && !holidays.has(iso)) n++;
  }
  return n;
}

interface SoDateRow {
  so_id?: string;
  soId?: string;
  customer?: string | null;
  customer_dd?: string | null;
  customerDd?: string | null;
}

/**
 * Build the late-risk report from the live plan.
 *
 * `shipBufferDays` is the working-day gap reserved between finishing the last
 * operation and handing goods to the customer; it defaults to the same value
 * the backward pass uses so the two can never drift apart.
 */
export async function buildLateRiskReport(
  db: DbLike,
  opts: { shipBufferDays?: number } = {},
): Promise<LateRiskReport> {
  const shipBufferDays = opts.shipBufferDays ?? DEFAULT_SHIP_BUFFER_DAYS;
  const holidays = await loadHolidaySet(db as unknown as WiderDb);

  const { assignments, generatedAt } = await computeChainWithAssignments(
    db as unknown as D1Database,
  );

  // Last scheduled operation per order — that is when the order is done.
  interface Agg {
    finish: string;
    dept: string;
    cards: number;
  }
  const byOrder = new Map<string, Agg>();
  for (const a of assignments) {
    const key = (a.soId || a.soPo || "").trim();
    if (!key) continue;
    const cur = byOrder.get(key);
    if (!cur) {
      byOrder.set(key, { finish: a.date, dept: a.dept, cards: a.jcIds.length });
      continue;
    }
    cur.cards += a.jcIds.length;
    if (a.date > cur.finish) {
      cur.finish = a.date;
      cur.dept = a.dept;
    }
  }

  // Customer dates for exactly the orders in the plan.
  const dates = new Map<string, { customer: string; dd: string | null }>();
  try {
    const res = await db
      .prepare(
        `SELECT DISTINCT
                COALESCE(po.companySOId, po.salesOrderId) AS so_id,
                po.customerName                           AS customer,
                so.customerDeliveryDate                   AS customer_dd
           FROM production_orders po
           LEFT JOIN sales_orders so ON so.id = po.salesOrderId
          WHERE po.status NOT IN ('ON_HOLD','CANCELLED')`,
      )
      .bind()
      .all<SoDateRow>();
    for (const r of res.results ?? []) {
      const key = String(r.soId ?? r.so_id ?? "").trim();
      if (!key) continue;
      const dd = (r.customerDd ?? r.customer_dd ?? null)?.slice(0, 10) || null;
      dates.set(key, { customer: r.customer ?? "", dd });
    }
  } catch (e) {
    console.warn("[late-risk] customer date lookup failed:", e);
  }

  const late: LateOrder[] = [];
  const atRisk: LateOrder[] = [];
  let undated = 0;

  for (const [soId, agg] of byOrder) {
    const info = dates.get(soId);
    const customerDd = info?.dd ?? null;
    if (!customerDd) {
      undated++;
      continue;
    }
    const deadline = backWorkingDays(customerDd, shipBufferDays, holidays);
    const row: LateOrder = {
      soId,
      customer: info?.customer ?? "",
      customerDd,
      deadline,
      scheduledFinish: agg.finish,
      finishDept: agg.dept,
      workingDaysLate: workingDaysBetween(deadline, agg.finish, holidays),
      cards: agg.cards,
    };
    if (agg.finish > deadline) late.push(row);
    else if (agg.finish === deadline) atRisk.push(row);
  }

  late.sort((a, b) =>
    b.workingDaysLate - a.workingDaysLate || (a.customerDd < b.customerDd ? -1 : 1),
  );
  atRisk.sort((a, b) => (a.customerDd < b.customerDd ? -1 : 1));

  return {
    generatedAt,
    shipBufferDays,
    late,
    atRisk,
    undated,
    totalOrdersPlanned: byOrder.size,
  };
}
