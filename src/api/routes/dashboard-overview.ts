// ---------------------------------------------------------------------------
// Dashboard overview — server-aggregated KPIs for the rebuilt homepage.
//
// One round-trip, 60s KV-cached. Sales/Delivery value figures intentionally
// come from the existing /api/sales-orders/stats + /api/delivery-orders/stats
// (the exact item-level resolver) — this endpoint adds the things that had
// NO aggregation before: production summary, purchasing summary, fabric cost
// per meter (consumption basis), AOV by customer × category, top sellers by
// category, and active headcount.
//
// Mounted at /api/dashboard/overview. Auth-gated globally; tenant-scoped.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import { loadSoLinePriceIndex, priceForItem } from "../lib/do-value";
import { computeFabricMetrics } from "../lib/fabric-usage";

// DO statuses that mean goods have shipped — same set the all-time
// "Delivered" figure uses (loadDeliveredItemsValueSen) so This-Month
// Delivered reconciles with it.
const SHIPPED_DO_STATUSES = new Set([
  "LOADED",
  "IN_TRANSIT",
  "DELIVERED",
  "INVOICED",
]);

const app = new Hono<Env>();

const FABRIC_ITEM_GROUPS = ["B.M-FABR", "S.M-FABR", "S-FABRIC"];

function fmtISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const { cached } = await import("../lib/kv-cache");

  // Period filter for the sales-derived sections (AOV, Monthly,
  // Top Sellers): "all" or a specific "YYYY-MM". Everything else in
  // the payload is period-independent. Cached per period.
  const periodRaw = c.req.query("period") ?? "all";
  const period = /^\d{4}-\d{2}$/.test(periodRaw) ? periodRaw : "all";

  const data = await cached(c, `dashboard:overview:${orgId}:v14:${period}`, 60, async () => {
    const db = c.var.DB;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = fmtISO(today);
    const monthStart = fmtISO(
      new Date(today.getFullYear(), today.getMonth(), 1),
    );
    const monthPrefix = todayISO.slice(0, 7); // current calendar month
    const yesterdayISO = (() => {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return fmtISO(y);
    })();
    // Last 7 calendar days ending yesterday (for the Completed list).
    const last7StartISO = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() - 7);
      return fmtISO(d);
    })();

    // 7 most-recent COMPLETE working days (Mon-Sat), ending YESTERDAY —
    // same window the Planning page uses for Daily Capacity.
    const windowDays: string[] = [];
    {
      const cur = new Date(today);
      cur.setDate(cur.getDate() - 1);
      while (windowDays.length < 7) {
        if (cur.getDay() !== 0) windowDays.push(fmtISO(cur));
        cur.setDate(cur.getDate() - 1);
      }
    }
    const windowSet = new Set(windowDays);

    const [
      jcRes,
      activeJobsRes,
      poOpenRes,
      poSpendRes,
      poOutRes,
      poPendRes,
      grnQcRes,
      topSupRes,
      fabTotRes,
      fabExclRes,
      soAggRes,
      catTopRes,
      sofaLineRes,
      fabTopRes,
      fabMonthRes,
      invMonthRes,
      prodRevRes,
      soPriceIdx,
      delivItemsRes,
      delivDoRes,
      compYestRes,
      compLast7Res,
      fabRecvRes,
      backlogJcRes,
      headRes,
    ] = await Promise.all([
      db
        .prepare(
          "SELECT status, estMinutes, actualMinutes, wipQty, completedDate, dueDate FROM job_cards WHERE orgId = ?",
        )
        .bind(orgId)
        .all<{
          status: string;
          estMinutes: number | null;
          actualMinutes: number | null;
          wipQty: number | null;
          completedDate: string | null;
          dueDate: string | null;
        }>(),
      // Active Jobs — still-in-production POs, split Bedframe (units =
      // qty) vs Sofa (sets = distinct SOs), with the customer for the
      // click-through breakdown.
      db
        .prepare(
          `SELECT po.itemCategory AS "cat",
                  po.customerName AS "customerName",
                  COALESCE(SUM(po.quantity),0) AS "units",
                  COUNT(DISTINCT po.salesOrderId) AS "sos"
             FROM production_orders po
            WHERE po.orgId = ? AND po.status NOT IN ('COMPLETED','CANCELLED')
            GROUP BY po.itemCategory, po.customerName`,
        )
        .bind(orgId)
        .all<{
          cat: string | null;
          customerName: string | null;
          units: number;
          sos: number;
        }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM purchase_orders WHERE orgId = ? AND status NOT IN ('RECEIVED','CLOSED','CANCELLED')",
        )
        .bind(orgId)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COALESCE(SUM(totalSen),0) AS v FROM purchase_orders WHERE orgId = ? AND status != 'CANCELLED' AND orderDate >= ?",
        )
        .bind(orgId, monthStart)
        .first<{ v: number }>(),
      db
        .prepare(
          `SELECT COALESCE(SUM((poi.quantity - poi.receivedQty) * poi.unitPriceSen),0) AS v
             FROM purchase_order_items poi
             JOIN purchase_orders p ON p.id = poi.purchaseOrderId
            WHERE p.orgId = ? AND p.status NOT IN ('RECEIVED','CLOSED','CANCELLED')
              AND poi.quantity > poi.receivedQty`,
        )
        .bind(orgId)
        .first<{ v: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM purchase_order_items poi
             JOIN purchase_orders p ON p.id = poi.purchaseOrderId
            WHERE p.orgId = ? AND p.status NOT IN ('RECEIVED','CLOSED','CANCELLED')
              AND poi.receivedQty < poi.quantity`,
        )
        .bind(orgId)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM grns WHERE orgId = ? AND qcStatus = 'PENDING'",
        )
        .bind(orgId)
        .first<{ n: number }>(),
      db
        .prepare(
          // Aliases that aren't real DB columns MUST be double-quoted.
          // Postgres folds an unquoted `AS spendSen` to `spendsen`; the
          // snake→camel result mapper then can't reproduce `spendSen`, so
          // r.spendSen reads back undefined → 0 (the same bug that zeroed
          // Top Sellers). Double quotes make Postgres keep the exact name.
          `SELECT supplierName AS name, COALESCE(SUM(totalSen),0) AS "spendSen"
             FROM purchase_orders
            WHERE orgId = ? AND status != 'CANCELLED'
            GROUP BY supplierName
            ORDER BY COALESCE(SUM(totalSen),0) DESC
            LIMIT 5`,
        )
        .bind(orgId)
        .all<{ name: string; spendSen: number }>(),
      db
        .prepare(
          `SELECT COALESCE(SUM(cl.totalCostSen),0) AS sen, COALESCE(SUM(cl.qty),0) AS qty
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
            WHERE rm.orgId = ? AND cl.type = 'RM_ISSUE'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')`,
        )
        .bind(orgId)
        .first<{ sen: number; qty: number }>(),
      db
        .prepare(
          `SELECT COALESCE(SUM(cl.totalCostSen),0) AS sen, COALESCE(SUM(cl.qty),0) AS qty
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
             JOIN production_orders po ON po.id = cl.refId
            WHERE po.orgId = ? AND cl.type = 'RM_ISSUE' AND cl.refType = 'PRODUCTION_ORDER'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
              AND po.itemCategory NOT IN ('BEDFRAME','SOFA')`,
        )
        .bind(orgId)
        .first<{ sen: number; qty: number }>(),
      // Per-SO aggregate (confirmed orders only). Drives BOTH the AOV
      // table and the monthly Bedframe-units / Sofa-sets card:
      //   - bedframe is sold per piece → keep its line value & qty
      //   - sofa is sold per SET → one SO = one set; the set's price is
      //     the whole SO total (incl. pillows/accessories) per Wei Siang
      // companySODate (the official SO date) drives the monthly buckets.
      // NOTE every non-column alias is double-quoted on purpose.
      db
        .prepare(
          `SELECT so.id AS "soId",
                  so.customerName AS "custName",
                  substr(so.companySODate::text, 1, 7) AS "ym",
                  so.totalSen AS "soTotalSen",
                  COALESCE(SUM(CASE WHEN si.itemCategory = 'BEDFRAME' THEN si.lineTotalSen ELSE 0 END),0) AS "bfValueSen",
                  COALESCE(SUM(CASE WHEN si.itemCategory = 'BEDFRAME' THEN si.quantity ELSE 0 END),0) AS "bfQty",
                  MAX(CASE WHEN si.itemCategory = 'SOFA' THEN 1 ELSE 0 END) AS "hasSofa"
             FROM sales_orders so
             JOIN sales_order_items si ON si.salesOrderId = so.id
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
            GROUP BY so.id, so.customerName, so.companySODate, so.totalSen`,
        )
        .bind(orgId)
        .all<{
          soId: string;
          custName: string;
          ym: string | null;
          soTotalSen: number;
          bfValueSen: number;
          bfQty: number;
          hasSofa: number;
        }>(),
      // Top sellers — BEDFRAME by product code (qty basis), also split
      // by customer for the click-through. Accessory dropped per Wei
      // Siang (not wanted on the dashboard).
      db
        .prepare(
          `SELECT si.productCode AS "productCode",
                  so.customerName AS "custName",
                  substr(so.companySODate::text, 1, 7) AS "ym",
                  MAX(si.productName) AS "productName",
                  COALESCE(SUM(si.quantity),0) AS "qtySold",
                  COALESCE(SUM(si.lineTotalSen),0) AS "valueSen"
             FROM sales_order_items si
             JOIN sales_orders so ON so.id = si.salesOrderId
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
              AND si.itemCategory = 'BEDFRAME'
            GROUP BY si.productCode, so.customerName,
                     substr(so.companySODate::text, 1, 7)`,
        )
        .bind(orgId)
        .all<{
          productCode: string;
          custName: string | null;
          ym: string | null;
          productName: string;
          qtySold: number;
          valueSen: number;
        }>(),
      // Sofa lines — grouped into models in JS (model = the number
      // prefix of the product code, e.g. 5530-1A(RHF) → 5530). Value
      // per set = whole SO total, counted once per SO.
      db
        .prepare(
          `SELECT si.salesOrderId AS "soId", si.productCode AS "productCode",
                  so.customerName AS "custName", so.totalSen AS "soTotalSen",
                  substr(so.companySODate::text, 1, 7) AS "ym"
             FROM sales_order_items si
             JOIN sales_orders so ON so.id = si.salesOrderId
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
              AND si.itemCategory = 'SOFA'`,
        )
        .bind(orgId)
        .all<{
          soId: string;
          productCode: string;
          custName: string | null;
          soTotalSen: number;
          ym: string | null;
        }>(),
      // Top fabrics by ACTUAL production consumption (RM_ISSUE meters),
      // split Bedframe vs Sofa via the consuming PO's category (same
      // join the fabric-cost-excl query uses).
      db
        .prepare(
          `SELECT po.itemCategory AS "cat", rm.itemCode AS "fabCode",
                  MAX(rm.description) AS "fabName",
                  COALESCE(SUM(cl.qty),0) AS "meters",
                  COALESCE(SUM(cl.totalCostSen),0) AS "costSen"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
             JOIN production_orders po ON po.id = cl.refId
            WHERE po.orgId = ? AND cl.type = 'RM_ISSUE'
              AND cl.refType = 'PRODUCTION_ORDER'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
              AND po.itemCategory IN ('BEDFRAME','SOFA')
            GROUP BY po.itemCategory, rm.itemCode`,
        )
        .bind(orgId)
        .all<{
          cat: string;
          fabCode: string;
          fabName: string;
          meters: number;
          costSen: number;
        }>(),
      // Monthly fabric meters (RM_ISSUE), split Bedframe vs Sofa.
      db
        .prepare(
          `SELECT po.itemCategory AS "cat",
                  substr(cl.date::text, 1, 7) AS "ym",
                  COALESCE(SUM(cl.qty),0) AS "meters"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
             JOIN production_orders po ON po.id = cl.refId
            WHERE po.orgId = ? AND cl.type = 'RM_ISSUE'
              AND cl.refType = 'PRODUCTION_ORDER'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
              AND po.itemCategory IN ('BEDFRAME','SOFA')
            GROUP BY po.itemCategory, substr(cl.date::text, 1, 7)`,
        )
        .bind(orgId)
        .all<{ cat: string; ym: string | null; meters: number }>(),
      // Invoiced per month — by invoiceDate, every invoice except
      // CANCELLED (incl. DRAFT, per Wei Siang: all current invoices are
      // still DRAFT, so excluding them would leave the line empty).
      db
        .prepare(
          `SELECT substr(invoiceDate::text, 1, 7) AS "ym",
                  COALESCE(SUM(totalSen),0) AS "revenueSen"
             FROM invoices
            WHERE orgId = ? AND status != 'CANCELLED'
              AND invoiceDate IS NOT NULL
            GROUP BY substr(invoiceDate::text, 1, 7)
            ORDER BY substr(invoiceDate::text, 1, 7)`,
        )
        .bind(orgId)
        .all<{ ym: string | null; revenueSen: number }>(),
      // Production revenue per month — EXACT mirror of the Employee
      // page's /production-revenue gate: a PO's revenue is recognised
      // the month its LAST upholstery job card completes (all UPH JCs
      // COMPLETED/TRANSFERRED), priced SO line → CO line → product
      // master, × qty. Same SQL as working-hour-entries.ts so the two
      // screens reconcile.
      db
        .prepare(
          `WITH per_po AS (
             SELECT productionOrderId,
                    COUNT(*) AS total_uph,
                    SUM(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                                  AND completedDate IS NOT NULL
                             THEN 1 ELSE 0 END) AS done_uph,
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
           SELECT substr(per_po.unit_completed_at::text, 1, 7) AS "ym",
                  COALESCE(SUM(
                    COALESCE(
                      soi.unitPriceSen,
                      coi.unitPriceSen,
                      (SELECT COALESCE(p.basePriceSen, p.price1Sen)
                         FROM products p
                        WHERE p.code = po.productCode
                        ORDER BY p.basePriceSen DESC NULLS LAST, p.id
                        LIMIT 1),
                      0
                    ) * po.quantity
                  ),0) AS "revenueSen"
             FROM per_po
             JOIN production_orders po ON po.id = per_po.productionOrderId
             LEFT JOIN sales_order_items soi
                    ON soi.salesOrderId = po.salesOrderId
                   AND soi.lineNo = po.lineNo
             LEFT JOIN consignment_order_items coi
                    ON coi.consignmentOrderId = po.consignmentOrderId
                   AND coi.lineNo = po.lineNo
            WHERE po.itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
              AND per_po.unit_completed_at IS NOT NULL
            GROUP BY substr(per_po.unit_completed_at::text, 1, 7)
            ORDER BY substr(per_po.unit_completed_at::text, 1, 7)`,
        )
        .all<{ ym: string | null; revenueSen: number }>(),
      // SO-line price index — exact per-item price resolver (same one
      // the DO/invoice path uses) for This-Month Delivered.
      loadSoLinePriceIndex(db, orgId),
      db
        .prepare(
          "SELECT deliveryOrderId, productionOrderId, productCode, quantity FROM delivery_order_items WHERE orgId = ?",
        )
        .bind(orgId)
        .all<{
          deliveryOrderId: string;
          productionOrderId: string | null;
          productCode: string | null;
          quantity: number;
        }>(),
      db
        .prepare(
          "SELECT id, salesOrderId, status, deliveredAt, dispatchedAt, created_at FROM delivery_orders WHERE orgId = ?",
        )
        .bind(orgId)
        .all<{
          id: string;
          salesOrderId: string | null;
          status: string;
          deliveredAt: string | null;
          dispatchedAt: string | null;
          created_at: string | null;
        }>(),
      // Completed YESTERDAY — POs whose LAST upholstery JC completed
      // yesterday (same per_po gate as production revenue). Bedframe =
      // units (qty), Sofa = sets (distinct SO), + customer for the
      // click-through.
      db
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
           SELECT po.itemCategory AS "cat",
                  po.customerName AS "customerName",
                  COALESCE(SUM(po.quantity),0) AS "units",
                  COUNT(DISTINCT po.salesOrderId) AS "sos"
             FROM per_po
             JOIN production_orders po ON po.id = per_po.productionOrderId
            WHERE po.orgId = ?
              AND substr(per_po.unit_completed_at::text, 1, 10) = ?
            GROUP BY po.itemCategory, po.customerName`,
        )
        .bind(orgId, yesterdayISO)
        .all<{
          cat: string | null;
          customerName: string | null;
          units: number;
          sos: number;
        }>(),
      // Completed in the LAST 7 DAYS — per completion date, Bedframe
      // units + Sofa sets (no customer split). Same per_po gate.
      db
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
           SELECT substr(per_po.unit_completed_at::text, 1, 10) AS "d",
                  COALESCE(SUM(CASE WHEN po.itemCategory = 'BEDFRAME'
                                    THEN po.quantity ELSE 0 END),0) AS "bfUnits",
                  COUNT(DISTINCT CASE WHEN po.itemCategory = 'SOFA'
                                      THEN po.salesOrderId END) AS "sofaSets"
             FROM per_po
             JOIN production_orders po ON po.id = per_po.productionOrderId
            WHERE po.orgId = ?
              AND substr(per_po.unit_completed_at::text, 1, 10) >= ?
              AND substr(per_po.unit_completed_at::text, 1, 10) <= ?
            GROUP BY substr(per_po.unit_completed_at::text, 1, 10)
            ORDER BY substr(per_po.unit_completed_at::text, 1, 10)`,
        )
        .bind(orgId, last7StartISO, yesterdayISO)
        .all<{ d: string | null; bfUnits: number; sofaSets: number }>(),
      // Fabric PURCHASE price per SKU — from RM_RECEIPT ledger rows.
      // weighted avg = Σ cost ÷ Σ qty; plus min/max per-meter unit cost.
      db
        .prepare(
          `SELECT rm.itemCode AS "fabCode",
                  COALESCE(SUM(cl.totalCostSen),0) AS "totCostSen",
                  COALESCE(SUM(cl.qty),0) AS "totQty",
                  MIN(NULLIF(cl.unitCostSen,0)) AS "minUnitSen",
                  MAX(cl.unitCostSen) AS "maxUnitSen"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
            WHERE rm.orgId = ? AND cl.type = 'RM_RECEIPT'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
            GROUP BY rm.itemCode`,
        )
        .bind(orgId)
        .all<{
          fabCode: string;
          totCostSen: number;
          totQty: number;
          minUnitSen: number | null;
          maxUnitSen: number | null;
        }>(),
      // Per-JC rows for the Backlog-by-department drill-down — exact
      // mirror of the Planning page's capacityData: needs the JC's dept
      // + its production order's category & status.
      db
        .prepare(
          `SELECT jc.departmentCode AS "dept", jc.status AS "jcStatus",
                  jc.estMinutes AS "estMinutes", jc.actualMinutes AS "actualMinutes",
                  jc.wipQty AS "wipQty", jc.completedDate AS "completedDate",
                  po.itemCategory AS "cat", po.status AS "poStatus"
             FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
            WHERE jc.orgId = ?`,
        )
        .bind(orgId)
        .all<{
          dept: string | null;
          jcStatus: string;
          estMinutes: number | null;
          actualMinutes: number | null;
          wipQty: number | null;
          completedDate: string | null;
          cat: string | null;
          poStatus: string;
        }>(),
      // NOTE: `workers` is NOT org-scoped (no org_id column — the workers
      // route never filters by org). Do not add `WHERE orgId = ?` here.
      db
        .prepare(
          "SELECT departmentCode AS dept, COUNT(*) AS n FROM workers WHERE status = 'ACTIVE' GROUP BY departmentCode",
        )
        .all<{ dept: string; n: number }>(),
    ]);

    // ---- Production ----
    let capacityMin = 0;
    let backlogMin = 0;
    const capByDay = new Map<string, number>();
    for (const jc of jcRes.results ?? []) {
      const wip = Math.max(1, jc.wipQty ?? 1);
      const done = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
      if (done && jc.completedDate) {
        if (windowSet.has(jc.completedDate)) {
          const mins = (jc.actualMinutes ?? jc.estMinutes ?? 0) * wip;
          capacityMin += mins;
          capByDay.set(
            jc.completedDate,
            (capByDay.get(jc.completedDate) ?? 0) + mins,
          );
        }
      }
      if (
        jc.status !== "COMPLETED" &&
        jc.status !== "TRANSFERRED" &&
        jc.status !== "CANCELLED"
      ) {
        backlogMin += (jc.estMinutes ?? 0) * wip;
      }
    }
    const dailyCapacityMin = Math.round(capacityMin / 7);
    const backlogDays =
      dailyCapacityMin > 0
        ? Math.round((backlogMin / dailyCapacityMin) * 10) / 10
        : 0;
    // Daily Capacity drill-down: last 7 working days, oldest first.
    const capacityDays = [...windowDays]
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({ date, minutes: capByDay.get(date) ?? 0 }));

    // ---- Backlog per department (mirror of Planning capacityData) ----
    const DEPARTMENTS: { code: string; name: string }[] = [
      { code: "FAB_CUT", name: "Fabric Cutting" },
      { code: "FAB_SEW", name: "Fabric Sewing" },
      { code: "WOOD_CUT", name: "Wood Cutting" },
      { code: "FOAM", name: "Foam Bonding" },
      { code: "FRAMING", name: "Framing" },
      { code: "WEBBING", name: "Webbing" },
      { code: "UPHOLSTERY", name: "Upholstery" },
      { code: "PACKING", name: "Packing" },
    ];
    const backlogRows = backlogJcRes.results ?? [];
    const backlogByDept = DEPARTMENTS.map(({ code, name }) => {
      let windowTotal = 0;
      let sofaMin = 0;
      let bedframeMin = 0;
      for (const r of backlogRows) {
        if (r.dept !== code) continue;
        const wip = Math.max(1, r.wipQty ?? 1);
        if (
          (r.jcStatus === "COMPLETED" || r.jcStatus === "TRANSFERRED") &&
          r.completedDate &&
          windowSet.has(r.completedDate)
        ) {
          windowTotal += (r.actualMinutes ?? r.estMinutes ?? 0) * wip;
        }
        if (
          (r.poStatus === "IN_PROGRESS" || r.poStatus === "PENDING") &&
          r.jcStatus !== "COMPLETED" &&
          r.jcStatus !== "CANCELLED" &&
          r.jcStatus !== "TRANSFERRED"
        ) {
          const m = (r.estMinutes ?? 0) * wip;
          if ((r.cat ?? "").toUpperCase() === "SOFA") sofaMin += m;
          else if ((r.cat ?? "").toUpperCase() === "BEDFRAME")
            bedframeMin += m;
        }
      }
      const dailyCapMin = Math.round(windowTotal / 7);
      const totalMin = sofaMin + bedframeMin;
      const denom = dailyCapMin > 0 ? dailyCapMin : 1;
      return {
        dept: name,
        sofaMin,
        bedframeMin,
        totalMin,
        dailyCapMin,
        backlogDays: Math.round((totalMin / denom) * 10) / 10,
      };
    })
      .filter((d) => d.totalMin > 0 || d.dailyCapMin > 0)
      .sort((a, b) => b.backlogDays - a.backlogDays);
    const backlogGrandMin = backlogByDept.reduce(
      (s, d) => s + d.totalMin,
      0,
    );

    // ---- Active Jobs (pending) & Completed Yesterday ----
    // Bedframe counts as units (Σ qty); Sofa as sets (distinct SO).
    // Both keep a per-customer list for the click-through.
    const rollUp = (
      rows: {
        cat: string | null;
        customerName: string | null;
        units: number;
        sos: number;
      }[],
    ) => {
      let bedframeUnits = 0;
      let sofaSets = 0;
      const byCust = new Map<
        string,
        { bedframeUnits: number; sofaSets: number }
      >();
      for (const r of rows) {
        const cat = (r.cat ?? "").toUpperCase();
        const cust = r.customerName || "—";
        const u = Number(r.units) || 0;
        const s = Number(r.sos) || 0;
        const e =
          byCust.get(cust) ?? { bedframeUnits: 0, sofaSets: 0 };
        if (cat === "BEDFRAME") {
          bedframeUnits += u;
          e.bedframeUnits += u;
        } else if (cat === "SOFA") {
          sofaSets += s;
          e.sofaSets += s;
        }
        byCust.set(cust, e);
      }
      const byCustomer = [...byCust.entries()]
        .map(([customer, v]) => ({ customer, ...v }))
        .filter((v) => v.bedframeUnits > 0 || v.sofaSets > 0)
        .sort(
          (a, b) =>
            b.bedframeUnits + b.sofaSets - (a.bedframeUnits + a.sofaSets),
        );
      return { bedframeUnits, sofaSets, byCustomer };
    };
    const activeJobs = rollUp(activeJobsRes.results ?? []);
    const completedYesterday = rollUp(compYestRes.results ?? []);
    // Completed in the last 7 days, per day (no customer split). Fill
    // every day so the list is continuous (0 on idle days).
    const compByDay = new Map<string, { bf: number; sofa: number }>();
    for (const r of compLast7Res.results ?? []) {
      if (!r.d) continue;
      compByDay.set(r.d, {
        bf: Number(r.bfUnits) || 0,
        sofa: Number(r.sofaSets) || 0,
      });
    }
    const completedLast7: {
      date: string;
      bedframeUnits: number;
      sofaSets: number;
    }[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = fmtISO(d);
      const v = compByDay.get(iso) ?? { bf: 0, sofa: 0 };
      completedLast7.push({
        date: iso,
        bedframeUnits: v.bf,
        sofaSets: v.sofa,
      });
    }

    // ---- This-Month Delivered (item-level, shipped DOs, this month) ----
    // Mirrors loadDeliveredItemsValueSen but scoped to DOs whose
    // effective date (deliveredAt → dispatchedAt → created_at) is in
    // the current calendar month.
    const doInfo = new Map<
      string,
      { soId: string; shipped: boolean; ym: string }
    >();
    for (const d of delivDoRes.results ?? []) {
      const eff = d.deliveredAt || d.dispatchedAt || d.created_at || "";
      doInfo.set(d.id, {
        soId: d.salesOrderId ?? "",
        shipped: SHIPPED_DO_STATUSES.has(d.status),
        ym: String(eff).slice(0, 7),
      });
    }
    let thisMonthDeliveredSen = 0;
    for (const di of delivItemsRes.results ?? []) {
      const info = doInfo.get(di.deliveryOrderId);
      if (!info || !info.shipped || info.ym !== monthPrefix) continue;
      thisMonthDeliveredSen +=
        priceForItem(
          soPriceIdx,
          di.productionOrderId,
          info.soId,
          di.productCode,
        ) * (di.quantity || 0);
    }

    // ---- Fabric cost per meter (consumption basis) ----
    const avgPerMeter = (r: { sen: number; qty: number } | null): number =>
      r && Number(r.qty) > 0 ? Math.round(Number(r.sen) / Number(r.qty)) : 0;

    // ---- AOV by customer + monthly Bedframe units / Sofa sets ----
    // Bedframe is sold per piece: AOV = Σ bedframe line value ÷ Σ qty.
    // Sofa is sold per SET: one SO = one set, the set's price is the
    // whole SO total; AOV = Σ SO total ÷ number of sofa SOs.
    type AovAcc = {
      bfVal: number;
      bfQty: number;
      soVal: number;
      soSets: number;
    };
    // Period gate: AOV table / Monthly bedframe-sofa / Top Sellers
    // honour the selected period. Monthly Revenue + This-Month KPIs
    // stay period-independent (computed from the full set).
    const inPeriod = (ym: string | null | undefined) =>
      period === "all" || ym === period;
    const salesMonthsSet = new Set<string>();
    const aovMap = new Map<string, AovAcc>();
    // Per-customer → per-month AOV accumulator (drill-through: a
    // customer's monthly average, by SO date). Always all months.
    const aovCustMonth = new Map<string, Map<string, AovAcc>>();
    const monthMap = new Map<
      string,
      { bedframeUnits: number; sofaSets: number }
    >();
    // Sales-Order revenue per month (every confirmed SO total, by SO
    // date) — one of the three Monthly Revenue lenses. Period-free.
    const soRevMap = new Map<string, number>();
    for (const r of soAggRes.results ?? []) {
      const name = r.custName || "—";
      const bfVal = Number(r.bfValueSen) || 0;
      const bfQty = Number(r.bfQty) || 0;
      const isSofa = Number(r.hasSofa) === 1;
      if (r.ym) {
        salesMonthsSet.add(r.ym);
        soRevMap.set(
          r.ym,
          (soRevMap.get(r.ym) ?? 0) + (Number(r.soTotalSen) || 0),
        );
        let cm = aovCustMonth.get(name);
        if (!cm) {
          cm = new Map();
          aovCustMonth.set(name, cm);
        }
        const me =
          cm.get(r.ym) ?? { bfVal: 0, bfQty: 0, soVal: 0, soSets: 0 };
        me.bfVal += bfVal;
        me.bfQty += bfQty;
        if (isSofa) {
          me.soVal += Number(r.soTotalSen) || 0;
          me.soSets += 1;
        }
        cm.set(r.ym, me);
      }
      if (!inPeriod(r.ym)) continue;
      const e =
        aovMap.get(name) ?? { bfVal: 0, bfQty: 0, soVal: 0, soSets: 0 };
      e.bfVal += bfVal;
      e.bfQty += bfQty;
      if (isSofa) {
        e.soVal += Number(r.soTotalSen) || 0;
        e.soSets += 1;
      }
      aovMap.set(name, e);
      if (r.ym) {
        const m =
          monthMap.get(r.ym) ?? { bedframeUnits: 0, sofaSets: 0 };
        m.bedframeUnits += bfQty;
        if (isSofa) m.sofaSets += 1;
        monthMap.set(r.ym, m);
      }
    }
    const salesMonths = [...salesMonthsSet].sort((a, b) =>
      b.localeCompare(a),
    );
    // This-Month Sales = Σ confirmed-SO total for the current month.
    const thisMonthSalesSen = soRevMap.get(monthPrefix) ?? 0;
    const aovByCustomer = [...aovMap.entries()]
      .map(([customerName, e]) => ({
        customerName,
        bedframeAvgSen: e.bfQty > 0 ? Math.round(e.bfVal / e.bfQty) : 0,
        bedframeUnits: e.bfQty,
        sofaAvgSen: e.soSets > 0 ? Math.round(e.soVal / e.soSets) : 0,
        sofaSets: e.soSets,
        totalSen: e.bfVal + e.soVal,
      }))
      .sort((a, b) => b.totalSen - a.totalSen)
      .slice(0, 12);
    // Whole-company AOV (all customers combined).
    const aovCompany = (() => {
      let bfVal = 0,
        bfQty = 0,
        soVal = 0,
        soSets = 0;
      for (const e of aovMap.values()) {
        bfVal += e.bfVal;
        bfQty += e.bfQty;
        soVal += e.soVal;
        soSets += e.soSets;
      }
      return {
        bedframeAvgSen: bfQty > 0 ? Math.round(bfVal / bfQty) : 0,
        bedframeUnits: bfQty,
        sofaAvgSen: soSets > 0 ? Math.round(soVal / soSets) : 0,
        sofaSets: soSets,
        totalSen: bfVal + soVal,
      };
    })();
    // Per-customer monthly AOV (only the customers shown in the table).
    const aovMonthlyByCustomer: Record<
      string,
      {
        month: string;
        bedframeAvgSen: number;
        bedframeUnits: number;
        sofaAvgSen: number;
        sofaSets: number;
      }[]
    > = {};
    for (const { customerName } of aovByCustomer) {
      const cm = aovCustMonth.get(customerName);
      if (!cm) continue;
      aovMonthlyByCustomer[customerName] = [...cm.entries()]
        .map(([month, e]) => ({
          month,
          bedframeAvgSen: e.bfQty > 0 ? Math.round(e.bfVal / e.bfQty) : 0,
          bedframeUnits: e.bfQty,
          sofaAvgSen: e.soSets > 0 ? Math.round(e.soVal / e.soSets) : 0,
          sofaSets: e.soSets,
        }))
        .sort((a, b) => a.month.localeCompare(b.month));
    }
    const monthlySales = [...monthMap.entries()]
      .map(([month, m]) => ({
        month,
        bedframeUnits: m.bedframeUnits,
        sofaSets: m.sofaSets,
      }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    // ---- Monthly Revenue — three lenses (last 12 months) ----
    //   Sales Orders : Σ SO total, by SO date (orders taken)
    //   Invoices     : Σ invoice total (excl CANCELLED), by invoice date
    //   Production    : value of production finished, by the month its
    //                   last upholstery JC completed (Employee-page rule)
    const invRevMap = new Map<string, number>();
    for (const r of invMonthRes.results ?? []) {
      if (r.ym) invRevMap.set(r.ym, Number(r.revenueSen) || 0);
    }
    const prodRevMap = new Map<string, number>();
    for (const r of prodRevRes.results ?? []) {
      if (r.ym) prodRevMap.set(r.ym, Number(r.revenueSen) || 0);
    }
    const allMonths = [
      ...new Set([
        ...soRevMap.keys(),
        ...invRevMap.keys(),
        ...prodRevMap.keys(),
      ]),
    ]
      .sort((a, b) => a.localeCompare(b))
      .slice(-12);
    const monthlyRevenue = allMonths.map((month) => ({
      month,
      salesOrderSen: soRevMap.get(month) ?? 0,
      invoiceSen: invRevMap.get(month) ?? 0,
      productionSen: prodRevMap.get(month) ?? 0,
    }));

    // ---- Top sellers ----
    type SellerRow = {
      productCode: string;
      productName: string;
      qtySold: number;
      valueSen: number;
    };
    // BEDFRAME by product code (rows are per product × customer).
    const bfAgg = new Map<
      string,
      { productName: string; qtySold: number; valueSen: number }
    >();
    const bfCust = new Map<
      string,
      Map<string, { qty: number; valueSen: number }>
    >();
    for (const r of catTopRes.results ?? []) {
      if (!inPeriod(r.ym)) continue;
      const code = r.productCode ?? "";
      const q = Number(r.qtySold) || 0;
      const v = Number(r.valueSen) || 0;
      const a =
        bfAgg.get(code) ?? {
          productName: r.productName ?? "",
          qtySold: 0,
          valueSen: 0,
        };
      a.qtySold += q;
      a.valueSen += v;
      if (!a.productName && r.productName) a.productName = r.productName;
      bfAgg.set(code, a);
      let cm = bfCust.get(code);
      if (!cm) {
        cm = new Map();
        bfCust.set(code, cm);
      }
      const cust = r.custName || "—";
      const ce = cm.get(cust) ?? { qty: 0, valueSen: 0 };
      ce.qty += q;
      ce.valueSen += v;
      cm.set(cust, ce);
    }
    const bfList: SellerRow[] = [...bfAgg.entries()].map(([code, a]) => ({
      productCode: code,
      productName: a.productName,
      qtySold: a.qtySold,
      valueSen: a.valueSen,
    }));
    const byQty = (a: { qtySold: number }, b: { qtySold: number }) =>
      b.qtySold - a.qtySold;
    // SOFA: by model = the number prefix of the code (5530-1A(RHF) →
    // 5530). One SO = one set; value = whole SO total, once per SO.
    const sofaBySo = new Map<
      string,
      { code: string; total: number; cust: string }
    >();
    for (const r of sofaLineRes.results ?? []) {
      if (!inPeriod(r.ym)) continue;
      if (!r.soId || sofaBySo.has(r.soId)) continue;
      sofaBySo.set(r.soId, {
        code: r.productCode ?? "",
        total: Number(r.soTotalSen) || 0,
        cust: r.custName || "—",
      });
    }
    const sofaModelMap = new Map<
      string,
      { setsSold: number; valueSen: number }
    >();
    const sofaCust = new Map<
      string,
      Map<string, { sets: number; valueSen: number }>
    >();
    for (const { code, total, cust } of sofaBySo.values()) {
      const model = (code.split("-")[0] || code).trim().toUpperCase() || "—";
      const e = sofaModelMap.get(model) ?? { setsSold: 0, valueSen: 0 };
      e.setsSold += 1;
      e.valueSen += total;
      sofaModelMap.set(model, e);
      let cm = sofaCust.get(model);
      if (!cm) {
        cm = new Map();
        sofaCust.set(model, cm);
      }
      const ce = cm.get(cust) ?? { sets: 0, valueSen: 0 };
      ce.sets += 1;
      ce.valueSen += total;
      cm.set(cust, ce);
    }
    const topSellers = {
      BEDFRAME: bfList.sort(byQty).slice(0, 5),
      SOFA: [...sofaModelMap.entries()]
        .map(([model, e]) => ({
          model,
          setsSold: e.setsSold,
          valueSen: e.valueSen,
        }))
        .sort((a, b) => b.setsSold - a.setsSold)
        .slice(0, 5),
    };
    // Customer breakdown for the Top-Seller click-through (shown keys
    // only — keeps the payload small).
    const topSellersByCustomer = {
      BEDFRAME: Object.fromEntries(
        topSellers.BEDFRAME.map((p) => [
          p.productCode,
          [...(bfCust.get(p.productCode)?.entries() ?? [])]
            .map(([customer, v]) => ({
              customer,
              qty: v.qty,
              valueSen: v.valueSen,
            }))
            .sort((a, b) => b.qty - a.qty),
        ]),
      ) as Record<
        string,
        { customer: string; qty: number; valueSen: number }[]
      >,
      SOFA: Object.fromEntries(
        topSellers.SOFA.map((p) => [
          p.model,
          [...(sofaCust.get(p.model)?.entries() ?? [])]
            .map(([customer, v]) => ({
              customer,
              sets: v.sets,
              valueSen: v.valueSen,
            }))
            .sort((a, b) => b.sets - a.sets),
        ]),
      ) as Record<
        string,
        { customer: string; sets: number; valueSen: number }[]
      >,
    };
    // Which customers make up each month's Bedframe units / Sofa sets.
    const monthCustMap = new Map<
      string,
      Map<string, { bedframeUnits: number; sofaSets: number }>
    >();
    for (const r of soAggRes.results ?? []) {
      if (!r.ym || !inPeriod(r.ym)) continue;
      let cm = monthCustMap.get(r.ym);
      if (!cm) {
        cm = new Map();
        monthCustMap.set(r.ym, cm);
      }
      const cust = r.custName || "—";
      const ce =
        cm.get(cust) ?? { bedframeUnits: 0, sofaSets: 0 };
      ce.bedframeUnits += Number(r.bfQty) || 0;
      if (Number(r.hasSofa) === 1) ce.sofaSets += 1;
      cm.set(cust, ce);
    }
    const monthlySalesByCustomer: Record<
      string,
      { customer: string; bedframeUnits: number; sofaSets: number }[]
    > = {};
    for (const [month, cm] of monthCustMap.entries()) {
      monthlySalesByCustomer[month] = [...cm.entries()]
        .map(([customer, v]) => ({ customer, ...v }))
        .filter((v) => v.bedframeUnits > 0 || v.sofaSets > 0)
        .sort(
          (a, b) =>
            b.bedframeUnits + b.sofaSets - (a.bedframeUnits + a.sofaSets),
        );
    }

    // ---- Fabric module — split Bedframe vs Sofa (consumption) ----
    // Past-30-days actual + Next-30-days forecast (by Fab Cut due date,
    // BOM-computed) per fabric SKU — reuses the same engine the Fab Cut
    // page uses so the numbers reconcile system-wide.
    const fabMetrics = await computeFabricMetrics(db);
    // Purchase price per fabric SKU (from RM_RECEIPT ledger).
    const fabPrice = new Map<
      string,
      { avgSen: number; minSen: number; maxSen: number }
    >();
    for (const r of fabRecvRes.results ?? []) {
      const q = Number(r.totQty) || 0;
      fabPrice.set(r.fabCode ?? "", {
        avgSen: q > 0 ? Math.round((Number(r.totCostSen) || 0) / q) : 0,
        minSen: Math.round(Number(r.minUnitSen) || 0),
        maxSen: Math.round(Number(r.maxUnitSen) || 0),
      });
    }
    const fabTopByCat = (cat: string) =>
      (fabTopRes.results ?? [])
        .filter((r) => (r.cat ?? "").toUpperCase() === cat)
        .map((r) => {
          const fm = fabMetrics.get(r.fabCode ?? "");
          const fp = fabPrice.get(r.fabCode ?? "");
          return {
            fabCode: r.fabCode ?? "—",
            fabName: r.fabName ?? "",
            meters: Number(r.meters) || 0,
            costSen: Number(r.costSen) || 0,
            past30Meters: Math.round(fm?.lastMonthUsage ?? 0),
            next30Meters: Math.round(fm?.oneMonthUsage ?? 0),
            buyAvgSen: fp?.avgSen ?? 0,
            buyMinSen: fp?.minSen ?? 0,
            buyMaxSen: fp?.maxSen ?? 0,
          };
        })
        .filter((f) => f.meters > 0)
        .sort((a, b) => b.meters - a.meters)
        .slice(0, 8);
    const fabMonthByCat = (cat: string) =>
      (fabMonthRes.results ?? [])
        .filter((r) => r.ym && (r.cat ?? "").toUpperCase() === cat)
        .map((r) => ({
          month: r.ym as string,
          meters: Number(r.meters) || 0,
        }))
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12);
    const fabric = {
      BEDFRAME: { top: fabTopByCat("BEDFRAME"), monthly: fabMonthByCat("BEDFRAME") },
      SOFA: { top: fabTopByCat("SOFA"), monthly: fabMonthByCat("SOFA") },
    };

    const headByDept = (headRes.results ?? []).map((r) => ({
      dept: r.dept || "—",
      count: Number(r.n) || 0,
    }));

    return {
      salesThisMonthSen: thisMonthSalesSen,
      deliveredThisMonthSen: thisMonthDeliveredSen,
      production: {
        dailyCapacityMin,
        backlogMin,
        backlogDays,
        activeJobs,
        completedYesterday,
        completedLast7,
        capacityDays,
        backlogByDept,
        backlogGrandMin,
      },
      purchasing: {
        openPOCount: Number(poOpenRes?.n) || 0,
        spendThisMonthSen: Number(poSpendRes?.v) || 0,
        outstandingPOValueSen: Number(poOutRes?.v) || 0,
        itemsPendingReceipt: Number(poPendRes?.n) || 0,
        grnsPendingQC: Number(grnQcRes?.n) || 0,
        topSuppliers: (topSupRes.results ?? []).map((s) => ({
          name: s.name || "—",
          spendSen: Number(s.spendSen) || 0,
        })),
      },
      fabricCostPerMeterSen: {
        total: avgPerMeter(fabTotRes),
        exclBedframeSofa: avgPerMeter(fabExclRes),
      },
      aovByCustomer,
      aovCompany,
      aovMonthlyByCustomer,
      topSellers,
      topSellersByCustomer,
      fabric,
      monthlySales,
      monthlySalesByCustomer,
      monthlyRevenue,
      period,
      salesMonths,
      employee: {
        activeHeadcount: headByDept.reduce((s, d) => s + d.count, 0),
        byDept: headByDept.sort((a, b) => b.count - a.count),
      },
    };
  });

  return c.json({ success: true, ...data });
});

export default app;
