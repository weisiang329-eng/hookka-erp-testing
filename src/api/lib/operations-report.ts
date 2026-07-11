// ---------------------------------------------------------------------------
// Operations Report — Daily / Weekly / Monthly.
//
// One collector that assembles every section of the owner's "newspaper" report
// (production, cost, delivery, workforce/QC, sales, inventory, receivables,
// material, people, new products). It REUSES the system's existing calc logic
// wherever one exists so the report's numbers match the rest of the ERP
// (Command Center / P&L / Efficiency Overview); greenfield metrics that the
// system never had (on-time %, delivery-stage days) are derived here and are
// clearly commented as such.
//
// Money is integer sen (RM×100) throughout — the frontend divides by 100.
//
// Period model: every query filters on a [startYmd, endYmd] date range so the
// SAME code serves daily (start==end), weekly (Mon–Sun) and monthly. Only the
// window changes.
//
// Sections are filled incrementally; unfinished ones return `null` behind a
// stable type so the frontend contract never shifts. See WORK-TRACKER.
// ---------------------------------------------------------------------------
import {
  computeMonthlyEfficiencyByWorker,
  resolveEfficiencyAllowanceSen,
  type WorkerMonthlyEfficiency,
} from "./efficiency-allowance";

// Fabric / foam item-group keys (mirror dashboard-overview.ts:43 + the foam
// split the material section uses). Kept local so this file is self-contained.
const FABRIC_ITEM_GROUPS = ["B.M-FABR", "S.M-FABR", "S-FABRIC"];
const FOAM_ITEM_GROUPS = ["FOAM", "B.FILLER", "S.FILLER"];

export type OperationsPeriodKind = "daily" | "weekly" | "monthly";

export interface ResolvedPeriod {
  kind: OperationsPeriodKind;
  startYmd: string; // inclusive YYYY-MM-DD
  endYmd: string; // inclusive YYYY-MM-DD
  anchorYmd: string; // the requested date
  label: string; // human label, e.g. "June 2026" / "Week of 30 Jun 2026"
}

// -- period math (pure YMD, no timezone drift) ------------------------------

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[(m || 1) - 1]} ${y}`;
}

export function resolvePeriod(
  period: OperationsPeriodKind,
  anchorYmd: string,
): ResolvedPeriod {
  if (period === "daily") {
    return {
      kind: period,
      startYmd: anchorYmd,
      endYmd: anchorYmd,
      anchorYmd,
      label: anchorYmd,
    };
  }
  if (period === "weekly") {
    // ISO week: Monday .. Sunday containing the anchor.
    const d = new Date(anchorYmd + "T00:00:00Z");
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const backToMon = dow === 0 ? 6 : dow - 1;
    const startYmd = addDaysYmd(anchorYmd, -backToMon);
    const endYmd = addDaysYmd(startYmd, 6);
    return {
      kind: period,
      startYmd,
      endYmd,
      anchorYmd,
      label: `Week of ${startYmd}`,
    };
  }
  // monthly
  const ym = anchorYmd.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    kind: period,
    startYmd: `${ym}-01`,
    endYmd: `${ym}-${String(lastDay).padStart(2, "0")}`,
    anchorYmd,
    label: monthLabel(ym),
  };
}

// A range clause on the date portion of a column. Callers interpolate a
// trusted column name; the bounds are bound params.
function inList(vals: string[]): string {
  return vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
}

// -- section result types ---------------------------------------------------

export interface ProductionSection {
  bedframeUnits: number;
  sofaSets: number;
  overdueCount: number;
  onTimePct: number | null; // null until the delivery pass lands
}

export interface ProductionCostSection {
  labourSen: number;
  fabricSen: number;
  foamSen: number;
  otherMaterialSen: number;
  totalSen: number;
}

export interface TopSeller {
  label: string;
  code: string;
  units: number;
  valueSen: number;
}
export interface SalesSection {
  totalSen: number;
  orderCount: number;
  topSellers: TopSeller[];
}

export interface SupplierSpend {
  name: string;
  spendSen: number;
}
export interface PurchasingSection {
  poSpendSen: number;
  poCount: number;
  topSuppliers: SupplierSpend[];
}

export interface MaterialSection {
  fabricConsumedSen: number;
  foamConsumedSen: number;
  otherConsumedSen: number;
  fabricMetres: number;
  fabricCostPerMetreSen: number | null;
}

export interface WorkerEff {
  workerId: string;
  name: string;
  pct: number;
}
export interface WorkforceSection {
  activeWorkers: number | null;
  bonusEarned: number | null;
  topEfficiency: WorkerEff[];
  bottomEfficiency: WorkerEff[];
}

export interface OperationsReport {
  period: ResolvedPeriod;
  production: ProductionSection;
  productionCost: ProductionCostSection;
  sales: SalesSection;
  purchasing: PurchasingSection;
  material: MaterialSection;
  workforce: WorkforceSection;
  // Filled in later passes — stable placeholders so the frontend contract holds.
  delivery: null;
  inventory: null;
  receivables: null;
  people: null;
  newProducts: null;
}

type Db = D1Database;

// -- sections ---------------------------------------------------------------

async function collectProduction(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<ProductionSection> {
  // Units completed — same per_po gate the Command Center uses: a PO counts
  // only when ALL its UPHOLSTERY job cards are COMPLETED/TRANSFERRED, dated by
  // the latest completion (finish-month basis). (dashboard-overview.ts:686)
  const unitsRow = await db
    .prepare(
      `WITH per_po AS (
         SELECT productionOrderId,
                MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN completedDate END) AS unit_completed_at
           FROM job_cards
          WHERE departmentCode = 'UPHOLSTERY'
          GROUP BY productionOrderId
         HAVING COUNT(*) > 0
            AND SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN 1 ELSE 0 END) = COUNT(*)
       )
       SELECT COALESCE(SUM(CASE WHEN po.itemCategory = 'BEDFRAME'
                                THEN po.quantity ELSE 0 END),0) AS "bfUnits",
              COUNT(DISTINCT CASE WHEN po.itemCategory = 'SOFA'
                                  THEN po.salesOrderId END) AS "sofaSets"
         FROM per_po
         JOIN production_orders po ON po.id = per_po.productionOrderId
        WHERE po.orgId = ?
          AND substr(per_po.unit_completed_at::text, 1, 10) >= ?
          AND substr(per_po.unit_completed_at::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{ bfUnits: number; sofaSets: number }>();

  // Overdue — SO-level, mirrors collectOverdueData's header predicate
  // (schedule-overdue-report.ts): promised date passed and still in an active
  // production status. "As of" the period end.
  const overdueRow = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sales_orders
        WHERE orgId = ?
          AND customerDeliveryDate IS NOT NULL
          AND customerDeliveryDate <> ''
          AND substr(customerDeliveryDate::text, 1, 10) < ?
          AND status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','ON_HOLD')`,
    )
    .bind(orgId, p.endYmd)
    .first<{ n: number }>();

  return {
    bedframeUnits: Number(unitsRow?.bfUnits ?? 0),
    sofaSets: Number(unitsRow?.sofaSets ?? 0),
    overdueCount: Number(overdueRow?.n ?? 0),
    onTimePct: null, // derived in the delivery pass
  };
}

async function collectProductionCost(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<ProductionCostSection> {
  // Labour — posted labour ledger rows in the window (operational cost_ledger
  // path, matches accounting cost-by-line). Finish-dated.
  const labourRow = await db
    .prepare(
      `SELECT COALESCE(SUM(totalCostSen),0) AS v
         FROM cost_ledger
        WHERE orgId = ? AND type = 'LABOR_POSTED'
          AND substr(date::text, 1, 10) >= ? AND substr(date::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{ v: number }>();

  // Material consumed, split fabric / foam / other, from RM_ISSUE rows joined
  // to the material's item group. (dashboard-overview.ts:405 pattern.)
  const matRow = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN rm.itemGroup IN (${inList(FABRIC_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "fabricSen",
         COALESCE(SUM(CASE WHEN rm.itemGroup IN (${inList(FOAM_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "foamSen",
         COALESCE(SUM(CASE WHEN rm.itemGroup NOT IN (${inList(FABRIC_ITEM_GROUPS)})
                            AND rm.itemGroup NOT IN (${inList(FOAM_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "otherSen"
         FROM cost_ledger cl
         JOIN raw_materials rm ON rm.id = cl.itemId
        WHERE rm.orgId = ? AND cl.type = 'RM_ISSUE'
          AND substr(cl.date::text, 1, 10) >= ? AND substr(cl.date::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{ fabricSen: number; foamSen: number; otherSen: number }>();

  const labourSen = Number(labourRow?.v ?? 0);
  const fabricSen = Number(matRow?.fabricSen ?? 0);
  const foamSen = Number(matRow?.foamSen ?? 0);
  const otherMaterialSen = Number(matRow?.otherSen ?? 0);
  return {
    labourSen,
    fabricSen,
    foamSen,
    otherMaterialSen,
    totalSen: labourSen + fabricSen + foamSen + otherMaterialSen,
  };
}

async function collectSales(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<SalesSection> {
  // Confirmed-sales set (excludes DRAFT/CANCELLED/ON_HOLD), bucketed by
  // companySODate — same口径 as the Command Center revenue card.
  const totalRow = await db
    .prepare(
      `SELECT COALESCE(SUM(totalSen),0) AS v, COUNT(*) AS n
         FROM sales_orders
        WHERE orgId = ? AND status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
          AND (is_service_order = FALSE OR is_service_order IS NULL)
          AND substr(companySODate::text, 1, 10) >= ?
          AND substr(companySODate::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{ v: number; n: number }>();

  // Top bedframe SKUs by units in the window.
  const bfRows = await db
    .prepare(
      `SELECT si.productCode AS "code",
              MAX(si.productName) AS "name",
              COALESCE(SUM(si.quantity),0) AS "units",
              COALESCE(SUM(si.lineTotalSen),0) AS "valueSen"
         FROM sales_order_items si
         JOIN sales_orders so ON so.id = si.salesOrderId
        WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
          AND si.itemCategory = 'BEDFRAME'
          AND substr(so.companySODate::text, 1, 10) >= ?
          AND substr(so.companySODate::text, 1, 10) <= ?
        GROUP BY si.productCode
        ORDER BY COALESCE(SUM(si.quantity),0) DESC
        LIMIT 5`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .all<{ code: string; name: string; units: number; valueSen: number }>();

  const topSellers: TopSeller[] = (bfRows.results ?? []).map((r) => ({
    label: r.name || r.code,
    code: r.code,
    units: Number(r.units ?? 0),
    valueSen: Number(r.valueSen ?? 0),
  }));

  return {
    totalSen: Number(totalRow?.v ?? 0),
    orderCount: Number(totalRow?.n ?? 0),
    topSellers,
  };
}

async function collectPurchasing(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<PurchasingSection> {
  const spendRow = await db
    .prepare(
      `SELECT COALESCE(SUM(totalSen),0) AS v, COUNT(*) AS n
         FROM purchase_orders
        WHERE orgId = ? AND status != 'CANCELLED'
          AND substr(orderDate::text, 1, 10) >= ?
          AND substr(orderDate::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{ v: number; n: number }>();

  const supRows = await db
    .prepare(
      `SELECT supplierName AS name, COALESCE(SUM(totalSen),0) AS "spendSen"
         FROM purchase_orders
        WHERE orgId = ? AND status != 'CANCELLED'
          AND substr(orderDate::text, 1, 10) >= ?
          AND substr(orderDate::text, 1, 10) <= ?
        GROUP BY supplierName
        ORDER BY COALESCE(SUM(totalSen),0) DESC
        LIMIT 5`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .all<{ name: string; spendSen: number }>();

  return {
    poSpendSen: Number(spendRow?.v ?? 0),
    poCount: Number(spendRow?.n ?? 0),
    topSuppliers: (supRows.results ?? []).map((r) => ({
      name: r.name || "—",
      spendSen: Number(r.spendSen ?? 0),
    })),
  };
}

async function collectMaterial(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<MaterialSection> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN rm.itemGroup IN (${inList(FABRIC_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "fabricSen",
         COALESCE(SUM(CASE WHEN rm.itemGroup IN (${inList(FABRIC_ITEM_GROUPS)})
                           THEN cl.qty ELSE 0 END),0) AS "fabricQty",
         COALESCE(SUM(CASE WHEN rm.itemGroup IN (${inList(FOAM_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "foamSen",
         COALESCE(SUM(CASE WHEN rm.itemGroup NOT IN (${inList(FABRIC_ITEM_GROUPS)})
                            AND rm.itemGroup NOT IN (${inList(FOAM_ITEM_GROUPS)})
                           THEN cl.totalCostSen ELSE 0 END),0) AS "otherSen"
         FROM cost_ledger cl
         JOIN raw_materials rm ON rm.id = cl.itemId
        WHERE rm.orgId = ? AND cl.type = 'RM_ISSUE'
          AND substr(cl.date::text, 1, 10) >= ? AND substr(cl.date::text, 1, 10) <= ?`,
    )
    .bind(orgId, p.startYmd, p.endYmd)
    .first<{
      fabricSen: number;
      fabricQty: number;
      foamSen: number;
      otherSen: number;
    }>();

  const fabricConsumedSen = Number(row?.fabricSen ?? 0);
  const fabricMetres = Number(row?.fabricQty ?? 0);
  return {
    fabricConsumedSen,
    foamConsumedSen: Number(row?.foamSen ?? 0),
    otherConsumedSen: Number(row?.otherSen ?? 0),
    fabricMetres,
    fabricCostPerMetreSen:
      fabricMetres > 0 ? Math.round(fabricConsumedSen / fabricMetres) : null,
  };
}

async function collectWorkforce(
  db: Db,
  orgId: string,
  p: ResolvedPeriod,
): Promise<WorkforceSection> {
  // Per-worker efficiency over the window — THE ratio-of-sums figure the
  // Efficiency Overview shows (efficiency-allowance.ts).
  const effMap: Map<string, WorkerMonthlyEfficiency> =
    await computeMonthlyEfficiencyByWorker(db, p.startYmd, p.endYmd);

  // Worker names + bonus config. Active, non-TEST (payslips predicate).
  const workerRows = await db
    .prepare(
      `SELECT id, name, empNo,
              efficiencyAllowanceSen AS "allowanceSen",
              efficiencyThresholdPct AS "thresholdPct"
         FROM workers
        WHERE (status = 'ACTIVE' OR status IS NULL)
          AND (empNo IS NULL OR empNo NOT LIKE 'TEST%')`,
    )
    .bind()
    .all<{
      id: string;
      name: string;
      empNo: string | null;
      allowanceSen: number | null;
      thresholdPct: number | null;
    }>();

  const workers = workerRows.results ?? [];
  const nameById = new Map(workers.map((w) => [w.id, w.name] as const));

  let bonusEarned = 0;
  for (const w of workers) {
    const sen = resolveEfficiencyAllowanceSen(
      effMap.get(w.id),
      w.allowanceSen,
      w.thresholdPct,
    );
    if (sen > 0) bonusEarned += 1;
  }

  const ranked: WorkerEff[] = [];
  for (const [workerId, eff] of effMap.entries()) {
    if (eff.pct === null) continue;
    ranked.push({
      workerId,
      name: nameById.get(workerId) ?? workerId,
      pct: Math.round(eff.pct * 10) / 10,
    });
  }
  ranked.sort((a, b) => b.pct - a.pct);

  return {
    activeWorkers: workers.length,
    bonusEarned,
    topEfficiency: ranked.slice(0, 5),
    bottomEfficiency: ranked.slice(-5).reverse(),
  };
}

// -- assembler --------------------------------------------------------------

export async function collectOperationsReport(
  db: Db,
  orgId: string,
  period: OperationsPeriodKind,
  anchorYmd: string,
): Promise<OperationsReport> {
  const p = resolvePeriod(period, anchorYmd);

  const [production, productionCost, sales, purchasing, material, workforce] =
    await Promise.all([
      collectProduction(db, orgId, p),
      collectProductionCost(db, orgId, p),
      collectSales(db, orgId, p),
      collectPurchasing(db, orgId, p),
      collectMaterial(db, orgId, p),
      collectWorkforce(db, orgId, p),
    ]);

  return {
    period: p,
    production,
    productionCost,
    sales,
    purchasing,
    material,
    workforce,
    delivery: null,
    inventory: null,
    receivables: null,
    people: null,
    newProducts: null,
  };
}
