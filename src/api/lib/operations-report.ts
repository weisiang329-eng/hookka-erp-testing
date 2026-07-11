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

export interface LowStockItem {
  itemCode: string;
  itemGroup: string;
  balanceQty: number;
  minStock: number;
}
export interface DeadStockItem {
  itemCode: string;
  itemGroup: string;
  idleDays: number;
  lastMovement: string;
}
export interface InventorySection {
  rmStockValueSen: number;
  lowStockCount: number;
  lowStock: LowStockItem[];
  deadStock: DeadStockItem[];
}

export interface PersonChange {
  name: string;
  department: string | null;
}
export interface PeopleSection {
  joined: PersonChange[];
  left: PersonChange[];
}

export interface NewProduct {
  category: string;
  code: string;
  name: string;
  baseModel: string | null;
}
export type NewProductsSection = NewProduct[];

export interface OperationsReport {
  period: ResolvedPeriod;
  production: ProductionSection;
  productionCost: ProductionCostSection;
  sales: SalesSection;
  purchasing: PurchasingSection;
  material: MaterialSection;
  workforce: WorkforceSection;
  inventory: InventorySection;
  people: PeopleSection;
  newProducts: NewProductsSection;
  // Filled in the delivery pass — stable placeholders so the contract holds.
  delivery: null;
  receivables: null;
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

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = new Date(fromYmd + "T00:00:00Z").getTime();
  const b = new Date(toYmd + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

async function collectInventory(db: Db, orgId: string): Promise<InventorySection> {
  // Live snapshot — reorder status has no time dimension. Reference "today"
  // (UTC date is close enough for idle-day bucketing).
  const todayYmd = new Date().toISOString().slice(0, 10);

  // Raw-material stock value = Σ remaining FIFO layers × unit cost.
  const valueRow = await db
    .prepare(
      `SELECT COALESCE(SUM(b.remaining_qty * b.unit_cost_sen),0) AS "v"
         FROM rm_batches b
         JOIN raw_materials rm ON rm.id = b.rm_id
        WHERE rm.orgId = ?`,
    )
    .bind(orgId)
    .first<{ v: number }>();

  // Low stock — replicates the procurement page's lowStockRMs filter
  // (minStock > 0 AND balanceQty <= minStock; minStock 0 = "no threshold set").
  const lowRows = await db
    .prepare(
      `SELECT itemCode AS "itemCode", itemGroup AS "itemGroup",
              balanceQty AS "balanceQty", minStock AS "minStock"
         FROM raw_materials
        WHERE orgId = ? AND minStock > 0 AND balanceQty <= minStock
        ORDER BY (balanceQty - minStock) ASC
        LIMIT 12`,
    )
    .bind(orgId)
    .all<{
      itemCode: string;
      itemGroup: string;
      balanceQty: number;
      minStock: number;
    }>();

  const lowCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM raw_materials
        WHERE orgId = ? AND minStock > 0 AND balanceQty <= minStock`,
    )
    .bind(orgId)
    .first<{ n: number }>();

  // Dead stock — last movement per RM from the cost ledger; idle > 90 days.
  // RMs with no ledger movement can't be dated, so they don't appear.
  const moveRows = await db
    .prepare(
      `SELECT rm.itemCode AS "itemCode", rm.itemGroup AS "itemGroup",
              MAX(substr(cl.date::text, 1, 10)) AS "lastMovement"
         FROM cost_ledger cl
         JOIN raw_materials rm ON rm.id = cl.itemId
        WHERE rm.orgId = ?
        GROUP BY rm.itemCode, rm.itemGroup`,
    )
    .bind(orgId)
    .all<{ itemCode: string; itemGroup: string; lastMovement: string | null }>();

  const deadStock: DeadStockItem[] = [];
  for (const r of moveRows.results ?? []) {
    if (!r.lastMovement) continue;
    const idle = daysBetweenYmd(r.lastMovement, todayYmd);
    if (idle > 90) {
      deadStock.push({
        itemCode: r.itemCode,
        itemGroup: r.itemGroup,
        idleDays: idle,
        lastMovement: r.lastMovement,
      });
    }
  }
  deadStock.sort((a, b) => b.idleDays - a.idleDays);

  return {
    rmStockValueSen: Number(valueRow?.v ?? 0),
    lowStockCount: Number(lowCountRow?.n ?? 0),
    lowStock: (lowRows.results ?? []).map((r) => ({
      itemCode: r.itemCode,
      itemGroup: r.itemGroup,
      balanceQty: Number(r.balanceQty ?? 0),
      minStock: Number(r.minStock ?? 0),
    })),
    deadStock: deadStock.slice(0, 8),
  };
}

async function collectPeople(db: Db, p: ResolvedPeriod): Promise<PeopleSection> {
  // SELECT * — the workers table 500s on a camelCase column projection
  // (see MEMORY worker_punch_clock); read dual-keyed off the full row.
  const rows = await db
    .prepare("SELECT * FROM workers")
    .bind()
    .all<Record<string, unknown>>();

  const inWindow = (v: unknown): boolean => {
    if (typeof v !== "string" || v.length < 7) return false;
    const d = v.slice(0, 10);
    return d >= p.startYmd && d <= p.endYmd;
  };
  const pick = (r: Record<string, unknown>, ...keys: string[]): unknown => {
    for (const k of keys) if (r[k] != null) return r[k];
    return null;
  };
  const dept = (r: Record<string, unknown>): string | null => {
    const d = pick(r, "department", "departmentCode", "dept");
    return typeof d === "string" && d ? d : null;
  };
  const name = (r: Record<string, unknown>): string =>
    String(pick(r, "name", "empName", "workerName") ?? "—");

  const joined: PersonChange[] = [];
  const left: PersonChange[] = [];
  for (const r of rows.results ?? []) {
    const empNo = String(pick(r, "empNo", "emp_no") ?? "");
    if (empNo.startsWith("TEST")) continue;
    if (inWindow(pick(r, "joinDate", "join_date"))) {
      joined.push({ name: name(r), department: dept(r) });
    }
    const status = String(pick(r, "status") ?? "");
    if (status === "RESIGNED" && inWindow(pick(r, "resignedAt", "resigned_at"))) {
      left.push({ name: name(r), department: dept(r) });
    }
  }
  return { joined, left };
}

async function collectNewProducts(
  db: Db,
  p: ResolvedPeriod,
): Promise<NewProductsSection> {
  // products has no orgId (global catalog). created_at was added for this
  // report — historical rows are NULL and simply don't appear.
  const rows = await db
    .prepare(
      `SELECT code, name, category, baseModel AS "baseModel"
         FROM products
        WHERE created_at IS NOT NULL
          AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
        ORDER BY created_at ASC`,
    )
    .bind(p.startYmd, p.endYmd)
    .all<{
      code: string;
      name: string;
      category: string;
      baseModel: string | null;
    }>();

  // One representative per category — the first created that month.
  const seen = new Set<string>();
  const out: NewProduct[] = [];
  for (const r of rows.results ?? []) {
    const cat = r.category || "OTHER";
    if (seen.has(cat)) continue;
    seen.add(cat);
    out.push({
      category: cat,
      code: r.code,
      name: r.name,
      baseModel: r.baseModel ?? null,
    });
  }
  return out;
}

// -- assembler --------------------------------------------------------------

export async function collectOperationsReport(
  db: Db,
  orgId: string,
  period: OperationsPeriodKind,
  anchorYmd: string,
): Promise<OperationsReport> {
  const p = resolvePeriod(period, anchorYmd);

  const [
    production,
    productionCost,
    sales,
    purchasing,
    material,
    workforce,
    inventory,
    people,
    newProducts,
  ] = await Promise.all([
    collectProduction(db, orgId, p),
    collectProductionCost(db, orgId, p),
    collectSales(db, orgId, p),
    collectPurchasing(db, orgId, p),
    collectMaterial(db, orgId, p),
    collectWorkforce(db, orgId, p),
    collectInventory(db, orgId),
    collectPeople(db, p),
    collectNewProducts(db, p),
  ]);

  return {
    period: p,
    production,
    productionCost,
    sales,
    purchasing,
    material,
    workforce,
    inventory,
    people,
    newProducts,
    delivery: null,
    receivables: null,
  };
}
