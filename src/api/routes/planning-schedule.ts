// ---------------------------------------------------------------------------
// Planning > live department schedule (Phase 2: all 8 production departments).
//
// GET /api/planning/schedule/fabric-cutting  (Phase 1, retained)
//   Batched-loads every WAITING FAB_CUT job card whose order is not
//   ON_HOLD / CANCELLED, normalizes each into a CutCard, loads the capacity
//   config (kv_config['planning_capacity'] over defaults), runs the pure
//   scheduleCutting() port, and returns the snapshot-shaped JSON the existing
//   Fabric Cutting page renderer already consumes.
//
// GET /api/planning/schedule/:dept  (Phase 2)
//   For dept in {fabric-cutting, fabric-sewing, wood-cutting, framing,
//   foam-bonding, upholstery, packing, webbing}. ONE batched load of all
//   WAITING production cards across departments, run computeChain() ONCE, and
//   return the requested dept's sheets. Upstream depts always run, so floors
//   stay consistent no matter which dept is requested.
//
//   Read-only — nothing is written to the ERP. ONE batched query (no per-card
//   round-trips), mirroring src/api/lib/schedule-overdue-report.ts.
//
// Mounted at /api/planning in src/api/worker.ts.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { loadCapacityConfig, type CapacityConfig, type Lane } from "../lib/planning-capacity";
import { scheduleCutting, type CutCard } from "../lib/planning-scheduler";
import {
  computeChain,
  type ChainCard,
  type ChainDept,
  type ChainOutput,
} from "../lib/planning-chain";

const app = new Hono<Env>();

const FAB_CUT = "FAB_CUT";
// Cards on these order statuses are excluded from planning.
const EXCLUDED_ORDER_STATUSES = new Set(["ON_HOLD", "CANCELLED"]);
// Categories that map to a cutting lane.
const LANE_CATEGORIES = new Set<Lane>(["BEDFRAME", "SOFA", "ACCESSORY"]);

interface FabCutRawRow {
  jobCardId: string;
  status: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  sequence: number | null;
  poId: string;
  companySOId: string | null;
  poNo: string | null;
  lineNo: number | null;
  itemCategory: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  customerName: string | null;
  orderStatus: string | null;
  salesOrderId: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
}

/** Local YYYY-MM-DD for a Date (never toISOString — that shifts by timezone). */
function fmtLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Cut identity = wipLabel's first "|"-segment (the layout sans size). */
function configOf(wipLabel: string | null): string {
  const wl = (wipLabel ?? "").trim();
  if (!wl) return "(none)";
  return wl.split("|")[0].trim() || "(none)";
}

/** "SO / PO" display id: companySOId + zero-padded line, else poNo. */
function soPoOf(r: FabCutRawRow): string {
  const so = (r.companySOId ?? "").trim();
  if (so) {
    const line = r.lineNo != null ? `-${String(r.lineNo).padStart(2, "0")}` : "";
    return `${so}${line}`;
  }
  return (r.poNo ?? r.poId).trim();
}

function normalizeCard(r: FabCutRawRow): CutCard {
  const lane = (r.itemCategory ?? "").toUpperCase() as Lane;
  return {
    soPo: soPoOf(r),
    customer: r.customerName ?? "",
    label: r.wipLabel ?? "",
    fabric: r.fabricCode ?? "",
    lane,
    config: configOf(r.wipLabel),
    size: (r.sizeLabel ?? "").trim(),
    sets: Math.max(1, r.wipQty ?? 1),
    customerDd: (r.customerDeliveryDate ?? "").slice(0, 10) || null,
    expectedDd: (r.hookkaExpectedDD ?? "").slice(0, 10) || null,
  };
}

app.get("/schedule/fabric-cutting", async (c) => {
  const db = c.var.DB;
  // orgId is read for tenant-scope parity with the other read endpoints; the
  // job_cards / production_orders tables are already org-scoped at the DB
  // layer in this deployment, so it isn't re-applied in the SQL filter.
  void getOrgId(c);

  // ── ONE batched query: WAITING FAB_CUT cards + their order + SO dates ──────
  const sql = `
    SELECT jc.id            AS jobCardId,
           jc.status        AS status,
           jc.wipLabel      AS wipLabel,
           jc.wipQty        AS wipQty,
           jc.sequence      AS sequence,
           po.id            AS poId,
           po.companySOId   AS companySOId,
           po.poNo          AS poNo,
           po.lineNo        AS lineNo,
           po.itemCategory  AS itemCategory,
           po.sizeLabel     AS sizeLabel,
           po.fabricCode    AS fabricCode,
           po.customerName  AS customerName,
           po.status        AS order_status,
           po.salesOrderId  AS salesOrderId,
           so.customerDeliveryDate AS customerDeliveryDate,
           so.hookkaExpectedDD     AS hookkaExpectedDD
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.productionOrderId
      LEFT JOIN sales_orders so ON so.id = po.salesOrderId
     WHERE jc.departmentCode = ?
       AND jc.status = 'WAITING'
     ORDER BY po.companySOId, jc.sequence`;
  const res = await db.prepare(sql).bind(FAB_CUT).all<FabCutRawRow>();
  const raw = res.results ?? [];

  const cards: CutCard[] = [];
  for (const r of raw) {
    if (EXCLUDED_ORDER_STATUSES.has((r.orderStatus ?? "").toUpperCase())) continue;
    const lane = (r.itemCategory ?? "").toUpperCase();
    if (!LANE_CATEGORIES.has(lane as Lane)) continue;
    cards.push(normalizeCard(r));
  }

  const config = await loadCapacityConfig(db);
  const { holidays, startDate, generatedAt } = await loadCalendarWindow(db);

  const snapshot = scheduleCutting({
    cards,
    config,
    holidays,
    startDate,
    generatedAt,
  });

  return c.json(snapshot);
});

// ── Shared calendar window (holidays + first working day + generatedAt) ──────
async function loadCalendarWindow(
  db: D1Database,
): Promise<{ holidays: string[]; startDate: string; generatedAt: string }> {
  const holidaySet = new Set<string>();
  const hrow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string }>();
  if (hrow?.value) {
    try {
      const arr = JSON.parse(hrow.value);
      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) holidaySet.add(d);
        }
      }
    } catch {
      // Malformed list → Sundays-only.
    }
  }
  const holidays = [...holidaySet];

  // START = tomorrow's first working day (skip Sundays + holidays). The
  // scheduler re-applies next_workday; we advance once so it's the real start.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const isOff = (d: Date): boolean => d.getDay() === 0 || holidaySet.has(fmtLocalIso(d));
  let guard = 0;
  while (isOff(start) && guard < 60) {
    start.setDate(start.getDate() + 1);
    guard++;
  }
  return {
    holidays,
    startDate: fmtLocalIso(start),
    generatedAt: fmtLocalIso(new Date()),
  };
}

// ── Phase 2: all-department live schedule ────────────────────────────────────
// URL slug → which dept's snapshot computeChain output to return.
const DEPT_SLUGS: Record<string, keyof ChainOutput> = {
  "fabric-cutting": "cutting",
  "fabric-sewing": "sewing",
  "wood-cutting": "woodCutting",
  framing: "framing",
  "foam-bonding": "foamBonding",
  upholstery: "upholstery",
  packing: "packing",
  webbing: "webbing",
};

// job_cards.departmentCode → which ChainDept (downstream chain) a card feeds.
const DEPT_CODE_TO_CHAIN: Record<string, ChainDept> = {
  FAB_SEW: "FAB_SEW",
  WOOD_CUT: "WOOD_CUT",
  FRAMING: "FRAMING",
  WEBBING: "WEBBING",
  FOAM: "FOAM",
  UPHOLSTERY: "UPHOLSTERY",
  PACKING: "PACKING",
};

interface ChainRawRow {
  jobCardId: string;
  dueDate: string | null;
  departmentCode: string | null;
  status: string | null;
  wipLabel: string | null;
  wipCode: string | null;
  wipType: string | null;
  wipQty: number | null;
  category: string | null;
  productionTimeMinutes: number | null;
  estMinutes: number | null;
  sequence: number | null;
  poId: string;
  companySOId: string | null;
  poNo: string | null;
  lineNo: number | null;
  itemCategory: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  productCode: string | null;
  customerName: string | null;
  orderStatus: string | null;
  salesOrderId: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
}

/** "SO / PO" display id for a chain row (companySOId + zero-padded line). */
function soPoOfChain(r: ChainRawRow): string {
  const so = (r.companySOId ?? "").trim();
  if (so) {
    const line = r.lineNo != null ? `-${String(r.lineNo).padStart(2, "0")}` : "";
    return `${so}${line}`;
  }
  return (r.poNo ?? r.poId).trim();
}

function laneOf(r: ChainRawRow): Lane | null {
  // The lane is the ORDER's itemCategory (BEDFRAME / SOFA / ACCESSORY). The job
  // card's own `category` is a production/cost bucket ("CAT 10", "CAT 14", …),
  // NOT a lane — reading it first made laneOf() return null and silently
  // dropped every downstream card (sew/wood/framing/…). itemCategory is the
  // reliable lane, so prefer it; keep category only as a last-ditch fallback.
  const cat = (r.itemCategory ?? r.category ?? "").toUpperCase();
  if (cat === "BEDFRAME" || cat === "SOFA" || cat === "ACCESSORY") return cat as Lane;
  return null;
}

/** Model = the product code, falling back to the wipLabel's first segment. */
function modelOf(r: ChainRawRow): string {
  const pc = (r.productCode ?? "").trim();
  if (pc) return pc;
  const wl = (r.wipLabel ?? "").trim();
  return wl ? wl.split("|")[0].trim() : "";
}

function normalizeChainCard(r: ChainRawRow, dept: ChainDept): ChainCard {
  const lane = (laneOf(r) ?? "ACCESSORY") as Lane;
  const qty = Math.max(1, r.wipQty ?? 1);
  const perUnit = r.productionTimeMinutes ?? 0;
  const mins = perUnit > 0 ? perUnit * qty : r.estMinutes ?? 0;
  return {
    dept,
    soPo: soPoOfChain(r),
    soId: (r.companySOId ?? r.salesOrderId ?? "").trim(),
    customer: r.customerName ?? "",
    label: r.wipLabel ?? r.wipCode ?? "",
    fabric: r.fabricCode ?? "",
    lane,
    model: modelOf(r),
    size: (r.sizeLabel ?? "").trim(),
    sets: qty,
    mins,
    customerDd: (r.customerDeliveryDate ?? "").slice(0, 10) || null,
    expectedDd: (r.hookkaExpectedDD ?? "").slice(0, 10) || null,
    wipType: (r.wipType ?? "").toUpperCase(),
    // Cut state is resolved within the chain by the cutting plan; a downstream
    // card with no fabric-cut step is treated as ready (sewing floor = day 1
    // when the line never appears in the cutting plan).
    cutDone: false,
    noCutStep: false,
  };
}

// Per-card link back to the source job card, keyed by the exact normalized
// card OBJECT (each raw row becomes exactly one CutCard / ChainCard here, so
// object identity is a loss-free key).
interface CardJcMeta {
  jcId: string;
  poId: string;
  /** The job card's CURRENT persisted dueDate (YYYY-MM-DD) or null. */
  currentDue: string | null;
}

interface LoadedChainInputs {
  cutCards: CutCard[];
  chainCards: ChainCard[];
  meta: Map<CutCard | ChainCard, CardJcMeta>;
  config: CapacityConfig;
  holidays: string[];
  startDate: string;
  generatedAt: string;
}

// ONE batched load of every WAITING production card + order + SO dates,
// normalized into the chain engine's inputs. Shared by computeDeptSchedule
// (display sheets) and computeChainWithAssignments (Phase 2 proposals) so
// both always see the identical card set.
async function loadChainInputs(db: D1Database): Promise<LoadedChainInputs> {
  const sql = `
    SELECT jc.id             AS jobCardId,
           jc.dueDate        AS dueDate,
           jc.departmentCode AS departmentCode,
           jc.status         AS status,
           jc.wipLabel       AS wipLabel,
           jc.wipCode        AS wipCode,
           jc.wipType        AS wipType,
           jc.wipQty         AS wipQty,
           jc.category       AS category,
           jc.productionTimeMinutes AS productionTimeMinutes,
           jc.estMinutes     AS estMinutes,
           jc.sequence       AS sequence,
           po.id             AS poId,
           po.companySOId    AS companySOId,
           po.poNo           AS poNo,
           po.lineNo         AS lineNo,
           po.itemCategory   AS itemCategory,
           po.sizeLabel      AS sizeLabel,
           po.fabricCode     AS fabricCode,
           po.productCode    AS productCode,
           po.customerName   AS customerName,
           po.status         AS order_status,
           po.salesOrderId   AS salesOrderId,
           so.customerDeliveryDate AS customerDeliveryDate,
           so.hookkaExpectedDD     AS hookkaExpectedDD
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.productionOrderId
      LEFT JOIN sales_orders so ON so.id = po.salesOrderId
     WHERE jc.status = 'WAITING'
     ORDER BY po.companySOId, jc.sequence`;
  const res = await db.prepare(sql).all<ChainRawRow>();
  const raw = res.results ?? [];

  const cutCards: CutCard[] = [];
  const chainCards: ChainCard[] = [];
  const meta = new Map<CutCard | ChainCard, CardJcMeta>();
  for (const r of raw) {
    if (EXCLUDED_ORDER_STATUSES.has((r.orderStatus ?? "").toUpperCase())) continue;
    const code = (r.departmentCode ?? "").toUpperCase();
    const jcMeta: CardJcMeta = {
      jcId: r.jobCardId,
      poId: r.poId,
      currentDue: (r.dueDate ?? "").slice(0, 10) || null,
    };
    if (code === FAB_CUT) {
      const lane = laneOf(r);
      if (lane) {
        const card: CutCard = {
          soPo: soPoOfChain(r),
          customer: r.customerName ?? "",
          label: r.wipLabel ?? "",
          fabric: r.fabricCode ?? "",
          lane,
          config: (r.wipLabel ?? "").trim().split("|")[0].trim() || "(none)",
          size: (r.sizeLabel ?? "").trim(),
          sets: Math.max(1, r.wipQty ?? 1),
          customerDd: (r.customerDeliveryDate ?? "").slice(0, 10) || null,
          expectedDd: (r.hookkaExpectedDD ?? "").slice(0, 10) || null,
        };
        cutCards.push(card);
        meta.set(card, jcMeta);
      }
      continue;
    }
    const chainDept = DEPT_CODE_TO_CHAIN[code];
    if (!chainDept) continue;
    if (!laneOf(r)) continue;
    const card = normalizeChainCard(r, chainDept);
    chainCards.push(card);
    meta.set(card, jcMeta);
  }

  const config = await loadCapacityConfig(db);
  const { holidays, startDate, generatedAt } = await loadCalendarWindow(db);
  return { cutCards, chainCards, meta, config, holidays, startDate, generatedAt };
}

// Reusable: load WAITING cards, run the full chain ONCE, and return the
// snapshot-shaped output for ONE department. Shared by the GET route AND the
// assistant's get_production_schedule tool so both see byte-identical plans.
// Returns null for an unknown slug.
export async function computeDeptSchedule(
  db: D1Database,
  slug: string,
): Promise<ChainOutput[keyof ChainOutput] | null> {
  const which = DEPT_SLUGS[slug];
  if (!which) return null;

  const { cutCards, chainCards, config, holidays, startDate, generatedAt } =
    await loadChainInputs(db);

  const out = computeChain({
    cutCards,
    chainCards,
    config,
    holidays,
    startDate,
    generatedAt,
  });

  return out[which];
}

// ── Phase 2: machine-readable engine assignments (due-date proposals) ────────

/** One engine-scheduled assignment tied back to its source job card(s). */
export interface EngineAssignment {
  /**
   * Source job card ids. Today each normalized card maps 1:1 to a job card,
   * so this is a single-element array; kept an array for future card-level
   * aggregation (same line + dept collapsing).
   */
  jcIds: string[];
  poId: string;
  dept: ChainDept | "FAB_CUT";
  soPo: string;
  soId: string;
  lane: string;
  fabric: string;
  sets: number;
  /** Engine-scheduled working day, YYYY-MM-DD. */
  date: string;
  /** The job card's CURRENT persisted dueDate (YYYY-MM-DD) or null. */
  currentDue: string | null;
}

/**
 * Run the FULL chain once with a collector and return every (job card, day)
 * assignment. Reuses the exact card-building of computeDeptSchedule, so the
 * proposals always agree with the department schedule pages.
 */
export async function computeChainWithAssignments(db: D1Database): Promise<{
  generatedAt: string;
  startDate: string;
  assignments: EngineAssignment[];
}> {
  const { cutCards, chainCards, meta, config, holidays, startDate, generatedAt } =
    await loadChainInputs(db);

  const assignments: EngineAssignment[] = [];
  computeChain({
    cutCards,
    chainCards,
    config,
    holidays,
    startDate,
    generatedAt,
    collect: (a) => {
      const m = meta.get(a.card);
      if (!m) return;
      assignments.push({
        jcIds: [m.jcId],
        poId: m.poId,
        dept: a.dept,
        soPo: a.soPo,
        soId: a.soId,
        lane: a.lane,
        fabric: a.fabric,
        sets: a.sets,
        date: a.date,
        currentDue: m.currentDue,
      });
    },
  });

  return { generatedAt, startDate, assignments };
}

app.get("/schedule/:dept", async (c) => {
  const slug = c.req.param("dept");
  void getOrgId(c);
  const result = await computeDeptSchedule(c.var.DB, slug);
  if (!result) {
    return c.json({ error: `Unknown department "${slug}"` }, 404);
  }
  return c.json(result);
});

export default app;
