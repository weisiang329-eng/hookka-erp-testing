// ---------------------------------------------------------------------------
// cs-agent.ts — Customer Service Agent orchestrator (read-only).
//
// Blueprint (docs/AGENTS-BLUEPRINT.md · CS JD): customer asks "when can you
// deliver?"
// → the CS Agent runs the loop itself:
//
//   step 1 MATERIALS   → Procurement Agent (procurement-agent.ts): BOM needs
//                        vs stock; shortage → real open-PO expectedDate or
//                        an honest "unknown".
//   step 2 PRODUCTION  → the REAL schedule engine (computeChainWithAssignments
//                        in routes/planning-schedule.ts — the same chain the
//                        Planning pages and Production Agent P2 proposals
//                        use): the PACKING completion day for this order given
//                        the current WAITING queue. Orders not in the queue
//                        fall back to the promise-date capacity math (marked
//                        ESTIMATE, never silently).
//   step 3 DELIVERY    → next feasible dispatch working day after packing +
//                        a per-state transit allowance (kv_config['cs-agent']
//                        overridable), with the 3PL state-rate card consulted
//                        for lane notes.
//
// RED LINES (owner-defined, enforced in code):
//   * NEVER invent a date — every date comes from an engine output or a real
//     DB field. If any stage is UNKNOWN the promiseDate is null and the
//     answer says exactly which data is missing.
//   * READ-ONLY — this module writes nothing, ever.
//   * The reasoning chain (materials -> production -> delivery) is returned
//     step by step so the answer
//     is auditable.
// ---------------------------------------------------------------------------
import { computeChainWithAssignments } from "../routes/planning-schedule";
import { resolveStateCode } from "../../lib/malaysia-states";
import {
  materialAvailability,
  type MaterialAvailabilityResult,
} from "./procurement-agent";

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export type PromiseStage = "MATERIALS" | "PRODUCTION" | "DELIVERY";

export interface PromiseStep {
  stage: PromiseStage;
  /** Stage-complete date (YYYY-MM-DD) or null when unknown. */
  date: string | null;
  note: string;
}

export interface PromiseDeliveryResult {
  /** The real, defensible promise date — null when any stage is unknown. */
  promiseDate: string | null;
  /**
   * ENGINE      — production date came straight from the chain engine.
   * ESTIMATE    — production estimated via capacity math (order not in the
   *               WAITING queue) — usable but softer.
   * INSUFFICIENT_DATA — at least one stage could not be answered from data;
   *               promiseDate is null and caveats explain what's missing.
   */
  confidence: "ENGINE" | "ESTIMATE" | "INSUFFICIENT_DATA";
  steps: PromiseStep[];
  caveats: string[];
  /** Resolved order header when the query was SO-based. */
  order: {
    id: string;
    companySOId: string;
    customerName: string;
    status: string;
    customerDeliveryDate: string | null;
  } | null;
  /** Destination state used for the transit allowance (canonical code) or null. */
  stateCode: string | null;
  materials: MaterialAvailabilityResult | null;
}

export interface PromiseDeliveryQuery {
  /** SO reference — companySOId (e.g. "SO-2607-012") or internal id. */
  soRef?: string | null;
  /** Ad-hoc what-if: product code + qty instead of an SO. */
  productCode?: string | null;
  qty?: number | null;
  /** Destination state (canonical or legacy shorthand — resolved). */
  stateCode?: string | null;
  /** Tenant scope for the SO lookup. */
  orgId: string;
}

// ---------------------------------------------------------------------------
// Working-day calendar helpers (Sundays + kv_config public_holidays off —
// same convention as planning-schedule.ts loadCalendarWindow).
// ---------------------------------------------------------------------------

function fmtLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseLocalIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

async function loadHolidaySet(db: D1Database): Promise<Set<string>> {
  const holidays = new Set<string>();
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string }>();
  if (row?.value) {
    try {
      const arr = JSON.parse(row.value);
      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) holidays.add(d);
        }
      }
    } catch {
      // Malformed list → Sundays-only.
    }
  }
  return holidays;
}

function isOffDay(d: Date, holidays: Set<string>): boolean {
  return d.getDay() === 0 || holidays.has(fmtLocalIso(d));
}

/** The given date if it's a working day, else the next working day. */
function toWorkingDay(iso: string, holidays: Set<string>): string {
  const d = parseLocalIso(iso);
  let guard = 0;
  while (isOffDay(d, holidays) && guard < 60) {
    d.setDate(d.getDate() + 1);
    guard++;
  }
  return fmtLocalIso(d);
}

/** Advance `days` WORKING days from `iso` (0 → toWorkingDay(iso)). */
function addWorkingDays(iso: string, days: number, holidays: Set<string>): string {
  const d = parseLocalIso(toWorkingDay(iso, holidays));
  let left = Math.max(0, Math.ceil(days));
  let guard = 0;
  while (left > 0 && guard < 730) {
    d.setDate(d.getDate() + 1);
    guard++;
    if (!isOffDay(d, holidays)) left--;
  }
  return fmtLocalIso(d);
}

/** Working days strictly between fromIso (exclusive) and toIso (inclusive). */
function workingDaysBetween(
  fromIso: string,
  toIso: string,
  holidays: Set<string>,
): number {
  if (toIso <= fromIso) return 0;
  const d = parseLocalIso(fromIso);
  const end = parseLocalIso(toIso).getTime();
  let n = 0;
  let guard = 0;
  while (d.getTime() < end && guard < 730) {
    d.setDate(d.getDate() + 1);
    guard++;
    if (!isOffDay(d, holidays)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Transit allowance config (kv_config['cs-agent'] overridable, no deploy).
// ---------------------------------------------------------------------------

interface CsAgentConfig {
  transitDaysByState: Record<string, number>;
  defaultTransitDays: number;
}

// Simple working-day transit allowances by destination state: Klang Valley
// +1, rest of Peninsular +2, East Malaysia (sea freight leg) +3. These are
// ALLOWANCES for the promise (not carrier quotes) — the owner can override
// any state via kv_config['cs-agent'] = {"transitDaysByState":{"JHR":1},...}.
const DEFAULT_CS_CONFIG: CsAgentConfig = {
  transitDaysByState: {
    KUL: 1, SGR: 1, PJY: 1,
    NSN: 2, MLK: 2, JHR: 2, PRK: 2, PHG: 2, PNG: 2,
    KDH: 3, PLS: 3, KTN: 3, TRG: 3,
    SBH: 3, SWK: 3, LBN: 3,
  },
  defaultTransitDays: 2,
};

async function loadCsConfig(db: D1Database): Promise<CsAgentConfig> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("cs-agent")
    .first<{ value: string }>();
  if (!row?.value) return DEFAULT_CS_CONFIG;
  try {
    const parsed = JSON.parse(row.value) as Partial<CsAgentConfig>;
    return {
      transitDaysByState: {
        ...DEFAULT_CS_CONFIG.transitDaysByState,
        ...(parsed.transitDaysByState && typeof parsed.transitDaysByState === "object"
          ? parsed.transitDaysByState
          : {}),
      },
      defaultTransitDays:
        typeof parsed.defaultTransitDays === "number" &&
        parsed.defaultTransitDays >= 0
          ? parsed.defaultTransitDays
          : DEFAULT_CS_CONFIG.defaultTransitDays,
    };
  } catch {
    return DEFAULT_CS_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type SoHeaderRow = {
  id: string;
  companySOId: string | null;
  customerName: string | null;
  customerId: string | null;
  status: string | null;
  customerDeliveryDate: string | null;
};

type SoItemRow = {
  productCode: string | null;
  productName: string | null;
  quantity: number | null;
};

type ProductRow = {
  id: string;
  code: string;
  productionTimeMinutes: number | null;
};

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export async function promiseDelivery(
  db: D1Database,
  query: PromiseDeliveryQuery,
): Promise<PromiseDeliveryResult> {
  const caveats: string[] = [];
  const steps: PromiseStep[] = [];
  const holidays = await loadHolidaySet(db);
  const today = fmtLocalIso(new Date());

  // ── Resolve the subject: an SO or an ad-hoc product line ──────────────────
  let order: PromiseDeliveryResult["order"] = null;
  let orderCustomerId: string | null = null;
  let lines: Array<{ productCode: string; qty: number }> = [];

  const soRef = (query.soRef ?? "").trim();
  if (soRef) {
    const so = await db
      .prepare(
        `SELECT id, companySOId, customerName, customerId, status, customerDeliveryDate
           FROM sales_orders
          WHERE orgId = ? AND (companySOId ILIKE ? OR id ILIKE ?)
          LIMIT 1`,
      )
      .bind(query.orgId, soRef, soRef)
      .first<SoHeaderRow>();
    if (!so) {
      return {
        promiseDate: null,
        confidence: "INSUFFICIENT_DATA",
        steps,
        caveats: [`Sales order not found: ${soRef}`],
        order: null,
        stateCode: null,
        materials: null,
      };
    }
    orderCustomerId = so.customerId ?? null;
    order = {
      id: so.id,
      companySOId: (so.companySOId ?? "").trim(),
      customerName: so.customerName ?? "",
      status: (so.status ?? "").toUpperCase(),
      customerDeliveryDate: (so.customerDeliveryDate ?? "").slice(0, 10) || null,
    };
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      caveats.push(
        `SO ${order.companySOId || order.id} is ${order.status} — a delivery promise no longer applies.`,
      );
    }
    const itemsRes = await db
      .prepare(
        `SELECT productCode, productName, quantity
           FROM sales_order_items
          WHERE salesOrderId = ?
          ORDER BY lineNo`,
      )
      .bind(so.id)
      .all<SoItemRow>();
    lines = (itemsRes.results ?? [])
      .filter((r) => (r.productCode ?? "").trim())
      .map((r) => ({
        productCode: (r.productCode ?? "").trim(),
        qty: Math.max(1, Number(r.quantity) || 1),
      }));
  } else {
    const pc = (query.productCode ?? "").trim();
    if (!pc) {
      return {
        promiseDate: null,
        confidence: "INSUFFICIENT_DATA",
        steps,
        caveats: ["Provide either an SO reference or a productCode + qty."],
        order: null,
        stateCode: null,
        materials: null,
      };
    }
    lines = [{ productCode: pc, qty: Math.max(1, Math.floor(query.qty || 1)) }];
  }

  // ── Destination state: explicit param > customer's default delivery hub ───
  let stateCode: string | null = resolveStateCode(query.stateCode ?? null);
  if (!stateCode && orderCustomerId) {
    const hub = await db
      .prepare(
        `SELECT state FROM delivery_hubs
          WHERE customerId = ?
          ORDER BY isDefault DESC
          LIMIT 1`,
      )
      .bind(orderCustomerId)
      .first<{ state: string | null }>();
    stateCode = resolveStateCode(hub?.state ?? null);
  }

  // ── Step 1 · MATERIALS (ask the Procurement Agent) ────────────────────────
  const materials = await materialAvailability(db, { lines });
  let materialReadyDate: string | null = null;
  let materialsKnown = false;
  if (!materials.ok) {
    // No BOM material data at all — the material leg simply can't be checked.
    // Production/delivery still run so the answer shows what IS known, but
    // the check is flagged loudly instead of pretending materials are fine.
    steps.push({
      stage: "MATERIALS",
      date: null,
      note: "Material availability NOT checked — no BOM material data for the requested product(s).",
    });
    caveats.push(...materials.notes);
    caveats.push(
      "Material availability is UNVERIFIED — per the honesty guard no promise date is given; the production/delivery steps below show what the schedule WOULD be once the BOM template carries materials.",
    );
    materialReadyDate = today;
    materialsKnown = false;
  } else if (materials.allEnough) {
    materialReadyDate = materials.readyDate ?? today;
    materialsKnown = true;
    steps.push({
      stage: "MATERIALS",
      date: materialReadyDate,
      note: `All ${materials.materials.length} BOM materials on hand — production can start on schedule.`,
    });
  } else if (materials.etaKnown && materials.readyDate) {
    materialReadyDate = materials.readyDate;
    materialsKnown = true;
    const shorts = materials.materials.filter((m) => !m.enough);
    steps.push({
      stage: "MATERIALS",
      date: materialReadyDate,
      note: `${shorts.length} material(s) short but covered by open PO(s) — latest expected arrival ${materialReadyDate}: ${shorts
        .map((m) => `${m.code} (short ${m.shortQty})`)
        .join(", ")}.`,
    });
  } else {
    const shorts = materials.materials.filter((m) => !m.enough && !m.etaKnown);
    steps.push({
      stage: "MATERIALS",
      date: null,
      note: `Material ETA UNKNOWN for: ${shorts
        .map((m) => `${m.code} (short ${m.shortQty} — ${m.note ?? "no covering PO"})`)
        .join("; ")}.`,
    });
    caveats.push(...materials.notes);
    materialReadyDate = null;
    materialsKnown = false;
  }

  // ── Step 2 · PRODUCTION (ask the schedule chain engine) ───────────────────
  // The chain engine schedules every WAITING card from `startDate` (next
  // working day). If this order is in the queue, its PACKING day IS the
  // production-complete date (ENGINE confidence).
  //
  // Material shift: the engine assumes materials are ready on startDate — it
  // has no per-order material constraint input. When materials arrive later
  // than startDate we shift this order's packing day forward by the number
  // of working days between startDate and the material-ready date. That is a
  // conservative deterministic transform of the engine output (queue ahead of
  // this order is unaffected; this order can only start later), documented
  // here rather than hidden.
  let productionDoneDate: string | null = null;
  let productionFromEngine = false;

  const engine = await computeChainWithAssignments(db);
  if (order && (order.companySOId || order.id)) {
    const key = order.companySOId || order.id;
    const mine = engine.assignments.filter(
      (a) =>
        (a.soId && a.soId === key) ||
        (key && a.soPo.toUpperCase().startsWith(key.toUpperCase())),
    );
    if (mine.length > 0) {
      const packing = mine.filter((a) => a.dept === "PACKING");
      const pool = packing.length > 0 ? packing : mine;
      if (packing.length === 0) {
        caveats.push(
          "No PACKING-stage card in the WAITING queue for this order — using its last scheduled stage as the production-complete day.",
        );
      }
      const lastDay = pool.reduce<string>(
        (max, a) => (a.date > max ? a.date : max),
        "",
      );
      if (lastDay) {
        productionDoneDate = lastDay;
        productionFromEngine = true;
        if (materialReadyDate && materialReadyDate > engine.startDate) {
          const shift = workingDaysBetween(
            engine.startDate,
            materialReadyDate,
            holidays,
          );
          if (shift > 0) {
            productionDoneDate = addWorkingDays(lastDay, shift, holidays);
            caveats.push(
              `Engine packing day ${lastDay} shifted +${shift} working day(s) because materials are only ready ${materialReadyDate} (engine start ${engine.startDate}).`,
            );
          }
        }
        steps.push({
          stage: "PRODUCTION",
          date: productionDoneDate,
          note: `Chain engine (live WAITING queue, start ${engine.startDate}): ${mine.length} scheduled card(s), ${packing.length > 0 ? "packing" : "last stage"} completes ${productionDoneDate}.`,
        });
      }
    }
  }

  if (!productionDoneDate) {
    // Not in the WAITING queue (ad-hoc product query, or the SO has no
    // WAITING cards — e.g. not exploded yet / already past packing). Estimate
    // with the SAME capacity arithmetic the coarse promise-date calculator
    // uses (src/api/routes/promise-date.ts): current queue minutes ahead
    // across all WAITING/IN_PROGRESS cards + this order's own minutes,
    // divided by the daily capacity of the product's departments. This is a
    // capacity-level estimate, NOT a per-card schedule → confidence ESTIMATE.
    const estimate = await estimateProductionDays(db, lines);
    if (estimate) {
      const startBase = materialReadyDate && materialReadyDate > today
        ? materialReadyDate
        : today;
      // Engine starts tomorrow's working day; mirror that.
      const start = addWorkingDays(startBase, 1, holidays);
      productionDoneDate = addWorkingDays(start, estimate.days, holidays);
      steps.push({
        stage: "PRODUCTION",
        date: productionDoneDate,
        note: `Not in the live WAITING queue — capacity estimate: ~${estimate.queueDays} working day(s) of queue ahead + ~${estimate.orderDays} day(s) for this order → done ${productionDoneDate}. ${estimate.note}`,
      });
      caveats.push(
        "Production date is a capacity-level ESTIMATE (order not in the scheduling queue), not a per-card engine schedule.",
      );
    } else {
      steps.push({
        stage: "PRODUCTION",
        date: null,
        note: "Production time UNKNOWN — product has no production-time data (products.productionTimeMinutes / dept_working_times) and no cards in the queue.",
      });
    }
  }

  // ── Step 3 · DELIVERY (dispatch window + state transit allowance) ─────────
  let promiseDate: string | null = null;
  if (productionDoneDate) {
    const config = await loadCsConfig(db);
    const dispatchDate = addWorkingDays(productionDoneDate, 1, holidays);
    const transitDays =
      stateCode != null
        ? config.transitDaysByState[stateCode] ?? config.defaultTransitDays
        : config.defaultTransitDays;
    promiseDate = addWorkingDays(dispatchDate, transitDays, holidays);

    let laneNote = "";
    if (stateCode) {
      // 3PL lane check — Phase-1 rate card (three_pl_state_rates). Purely a
      // note: rates say a lane exists; the transit allowance still governs.
      try {
        const lane = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM three_pl_state_rates
              WHERE state = ? AND ratePerTripSen > 0`,
          )
          .bind(stateCode)
          .first<{ n: number }>();
        const n = Number(lane?.n) || 0;
        laneNote =
          n > 0
            ? ` ${n} 3PL provider rate(s) on file for ${stateCode}.`
            : ` No 3PL rate on file for ${stateCode} yet — own-truck or quote needed.`;
      } catch {
        laneNote = "";
      }
    } else {
      caveats.push(
        "Destination state unknown (no state param and no customer delivery hub) — used the default transit allowance.",
      );
    }
    steps.push({
      stage: "DELIVERY",
      date: promiseDate,
      note: `Next dispatch working day after production: ${dispatchDate}; +${transitDays} working day(s) transit${stateCode ? ` to ${stateCode}` : ""} → delivered ${promiseDate}.${laneNote}`,
    });
  } else {
    steps.push({
      stage: "DELIVERY",
      date: null,
      note: "Cannot compute dispatch/transit — production completion date is unknown.",
    });
  }

  // ── Verdict (red line: any unknown stage → no promise) ────────────────────
  const anyUnknown = steps.some((s) => s.date === null);
  let confidence: PromiseDeliveryResult["confidence"];
  if (anyUnknown || !promiseDate) {
    confidence = "INSUFFICIENT_DATA";
    promiseDate = null;
    if (!caveats.some((c) => c.startsWith("No promise"))) {
      caveats.push(
        "No promise date given — at least one stage lacks real data (see steps). Fix the missing data rather than guessing.",
      );
    }
  } else if (productionFromEngine && materialsKnown) {
    confidence = "ENGINE";
  } else {
    confidence = "ESTIMATE";
  }

  if (promiseDate && order?.customerDeliveryDate && promiseDate > order.customerDeliveryDate) {
    caveats.push(
      `Computed promise ${promiseDate} is LATER than the customer's requested delivery date ${order.customerDeliveryDate} — flag proactively.`,
    );
  }

  return {
    promiseDate,
    confidence,
    steps,
    caveats,
    order,
    stateCode,
    materials,
  };
}

// ---------------------------------------------------------------------------
// Capacity-level production estimate (mirrors routes/promise-date.ts math).
// ---------------------------------------------------------------------------

async function estimateProductionDays(
  db: D1Database,
  lines: Array<{ productCode: string; qty: number }>,
): Promise<{ days: number; queueDays: number; orderDays: number; note: string } | null> {
  if (lines.length === 0) return null;

  // Product production minutes (per unit) by code.
  const products: ProductRow[] = [];
  for (const line of lines) {
    const p = await db
      .prepare(
        "SELECT id, code, productionTimeMinutes FROM products WHERE code ILIKE ? LIMIT 1",
      )
      .bind(line.productCode)
      .first<ProductRow>();
    if (p) products.push(p);
  }
  if (products.length === 0) return null;

  // Daily capacity: sum of workingHoursPerDay across the first product's
  // departments (dept_working_times), same shape as promise-date.ts. 8h/dept
  // fallback when a dept row is missing.
  const dwtRes = await db
    .prepare(
      "SELECT departmentCode, minutes FROM dept_working_times WHERE productId = ?",
    )
    .bind(products[0].id)
    .all<{ departmentCode: string; minutes: number }>();
  const dwts = dwtRes.results ?? [];
  const deptRes = await db
    .prepare("SELECT code, workingHoursPerDay FROM departments")
    .all<{ code: string; workingHoursPerDay: number | null }>();
  const hoursByDept = new Map(
    (deptRes.results ?? []).map((d) => [d.code, Number(d.workingHoursPerDay) || 8]),
  );
  const totalHoursPerDay =
    dwts.length > 0
      ? dwts.reduce((s, r) => s + (hoursByDept.get(r.departmentCode) ?? 8), 0)
      : 8 * Math.max(1, hoursByDept.size || 7);
  const dailyCapacityMinutes = Math.max(1, totalHoursPerDay * 60);

  // Queue minutes ahead — SAME query as promise-date.ts loadCoreState (incl.
  // the FAB_CUT per-set-total exception and the ×wipQty B1 fix), but summed
  // across ALL products since a new order joins the back of the whole queue.
  const queueRow = await db
    .prepare(
      `SELECT SUM(CASE WHEN jc.departmentCode = 'FAB_CUT'
                       THEN COALESCE(jc.estMinutes, 0)
                       ELSE jc.estMinutes * GREATEST(1, COALESCE(jc.wipQty, 1))
                  END) AS "totalMinutes"
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
          AND po.status IN ('PENDING','IN_PROGRESS','ON_HOLD','PAUSED')`,
    )
    .first<{ totalMinutes: number | null; totalminutes?: number | null }>();
  const queueMinutes =
    Number(queueRow?.totalMinutes ?? queueRow?.totalminutes) || 0;

  // This order's minutes = Σ productionTimeMinutes × qty per line (lines
  // whose product row was found; unfound lines already caveated upstream).
  let orderMinutes = 0;
  for (const line of lines) {
    const p = products.find(
      (x) => x.code.toUpperCase() === line.productCode.toUpperCase(),
    );
    if (p) orderMinutes += (Number(p.productionTimeMinutes) || 0) * line.qty;
  }
  if (orderMinutes <= 0 && queueMinutes <= 0) return null;

  const queueDays = Math.ceil(queueMinutes / dailyCapacityMinutes);
  const orderDays = Math.max(1, Math.ceil(orderMinutes / dailyCapacityMinutes));
  return {
    days: queueDays + orderDays,
    queueDays,
    orderDays,
    note: `Capacity basis: ${Math.round(dailyCapacityMinutes / 60)}h/day across the product's departments (mirrors /api/promise-date).`,
  };
}
