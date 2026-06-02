// ---------------------------------------------------------------------------
// Planning > live department schedule (Phase 1: Fabric Cutting only).
//
// GET /api/planning/schedule/fabric-cutting
//   Batched-loads every WAITING FAB_CUT job card whose order is not
//   ON_HOLD / CANCELLED, normalizes each into a CutCard, loads the capacity
//   config (kv_config['planning_capacity'] over defaults), runs the pure
//   scheduleCutting() port, and returns the snapshot-shaped JSON the existing
//   Fabric Cutting page renderer already consumes.
//
//   Read-only — nothing is written to the ERP. ONE batched query (no per-card
//   round-trips), mirroring src/api/lib/schedule-overdue-report.ts.
//
// Mounted at /api/planning in src/api/worker.ts.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { loadCapacityConfig, type Lane } from "../lib/planning-capacity";
import { scheduleCutting, type CutCard } from "../lib/planning-scheduler";

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
           po.status        AS orderStatus,
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

  // Calendar START = today's next working day. is_offday = Sunday OR holiday.
  const holidaySet = new Set<string>();
  {
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
  }
  const holidays = [...holidaySet];

  // START = tomorrow's first working day (skip Sundays + holidays). The
  // scheduler itself re-applies next_workday, but we advance once here so the
  // start date is the real first cutting day.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const isOff = (d: Date): boolean => d.getDay() === 0 || holidaySet.has(fmtLocalIso(d));
  let guard = 0;
  while (isOff(start) && guard < 60) {
    start.setDate(start.getDate() + 1);
    guard++;
  }
  const startDate = fmtLocalIso(start);
  const generatedAt = fmtLocalIso(new Date());

  const snapshot = scheduleCutting({
    cards,
    config,
    holidays,
    startDate,
    generatedAt,
  });

  return c.json(snapshot);
});

export default app;
