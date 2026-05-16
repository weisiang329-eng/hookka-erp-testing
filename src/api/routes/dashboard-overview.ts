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

const app = new Hono<Env>();

const FABRIC_ITEM_GROUPS = ["B.M-FABR", "S.M-FABR", "S-FABRIC"];

function fmtISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const { cached } = await import("../lib/kv-cache");

  const data = await cached(c, `dashboard:overview:${orgId}:v6`, 60, async () => {
    const db = c.var.DB;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = fmtISO(today);
    const monthStart = fmtISO(
      new Date(today.getFullYear(), today.getMonth(), 1),
    );

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
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM production_orders WHERE orgId = ? AND status IN ('IN_PROGRESS','PENDING')",
        )
        .bind(orgId)
        .first<{ n: number }>(),
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
      // Top sellers — BEDFRAME by product code (qty basis). Accessory
      // dropped per Wei Siang (not wanted on the dashboard).
      db
        .prepare(
          `SELECT si.productCode AS "productCode",
                  MAX(si.productName) AS "productName",
                  COALESCE(SUM(si.quantity),0) AS "qtySold",
                  COALESCE(SUM(si.lineTotalSen),0) AS "valueSen"
             FROM sales_order_items si
             JOIN sales_orders so ON so.id = si.salesOrderId
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
              AND si.itemCategory = 'BEDFRAME'
            GROUP BY si.productCode`,
        )
        .bind(orgId)
        .all<{
          productCode: string;
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
                  so.totalSen AS "soTotalSen"
             FROM sales_order_items si
             JOIN sales_orders so ON so.id = si.salesOrderId
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
              AND si.itemCategory = 'SOFA'`,
        )
        .bind(orgId)
        .all<{ soId: string; productCode: string; soTotalSen: number }>(),
      // Top fabrics by ACTUAL production consumption (RM_ISSUE meters).
      db
        .prepare(
          `SELECT rm.itemCode AS "fabCode", MAX(rm.description) AS "fabName",
                  COALESCE(SUM(cl.qty),0) AS "meters",
                  COALESCE(SUM(cl.totalCostSen),0) AS "costSen"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
            WHERE rm.orgId = ? AND cl.type = 'RM_ISSUE'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
            GROUP BY rm.itemCode
            ORDER BY SUM(cl.qty) DESC
            LIMIT 10`,
        )
        .bind(orgId)
        .all<{ fabCode: string; fabName: string; meters: number; costSen: number }>(),
      // Monthly fabric meters consumed (RM_ISSUE) — last-12 trend in JS.
      db
        .prepare(
          `SELECT substr(cl.date::text, 1, 7) AS "ym",
                  COALESCE(SUM(cl.qty),0) AS "meters"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
            WHERE rm.orgId = ? AND cl.type = 'RM_ISSUE'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
            GROUP BY substr(cl.date::text, 1, 7)
            ORDER BY substr(cl.date::text, 1, 7)`,
        )
        .bind(orgId)
        .all<{ ym: string | null; meters: number }>(),
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
    let completedToday = 0;
    for (const jc of jcRes.results ?? []) {
      const wip = Math.max(1, jc.wipQty ?? 1);
      const done = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
      if (done && jc.completedDate) {
        if (jc.completedDate === todayISO) completedToday++;
        if (windowSet.has(jc.completedDate))
          capacityMin += (jc.actualMinutes ?? jc.estMinutes ?? 0) * wip;
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

    // ---- Fabric cost per meter (consumption basis) ----
    const avgPerMeter = (r: { sen: number; qty: number } | null): number =>
      r && Number(r.qty) > 0 ? Math.round(Number(r.sen) / Number(r.qty)) : 0;

    // ---- AOV by customer + monthly Bedframe units / Sofa sets ----
    // Bedframe is sold per piece: AOV = Σ bedframe line value ÷ Σ qty.
    // Sofa is sold per SET: one SO = one set, the set's price is the
    // whole SO total; AOV = Σ SO total ÷ number of sofa SOs.
    const aovMap = new Map<
      string,
      { bfVal: number; bfQty: number; soVal: number; soSets: number }
    >();
    const monthMap = new Map<
      string,
      { bedframeUnits: number; sofaSets: number }
    >();
    // Sales-Order revenue per month (every confirmed SO total, by SO
    // date) — one of the three Monthly Revenue lenses.
    const soRevMap = new Map<string, number>();
    for (const r of soAggRes.results ?? []) {
      const name = r.custName || "—";
      const e =
        aovMap.get(name) ?? { bfVal: 0, bfQty: 0, soVal: 0, soSets: 0 };
      const bfVal = Number(r.bfValueSen) || 0;
      const bfQty = Number(r.bfQty) || 0;
      const isSofa = Number(r.hasSofa) === 1;
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
        soRevMap.set(
          r.ym,
          (soRevMap.get(r.ym) ?? 0) + (Number(r.soTotalSen) || 0),
        );
      }
    }
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
    // BEDFRAME / ACCESSORY: by product code, ranked by qty sold.
    type SellerRow = {
      productCode: string;
      productName: string;
      qtySold: number;
      valueSen: number;
    };
    const bfList: SellerRow[] = (catTopRes.results ?? []).map((r) => ({
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      qtySold: Number(r.qtySold) || 0,
      valueSen: Number(r.valueSen) || 0,
    }));
    const byQty = (a: { qtySold: number }, b: { qtySold: number }) =>
      b.qtySold - a.qtySold;
    // SOFA: by model = the number prefix of the code (5530-1A(RHF) →
    // 5530). One SO = one set; the set's value is the whole SO total,
    // counted once per SO.
    const sofaBySo = new Map<string, { code: string; total: number }>();
    for (const r of sofaLineRes.results ?? []) {
      if (!r.soId || sofaBySo.has(r.soId)) continue;
      sofaBySo.set(r.soId, {
        code: r.productCode ?? "",
        total: Number(r.soTotalSen) || 0,
      });
    }
    const sofaModelMap = new Map<
      string,
      { setsSold: number; valueSen: number }
    >();
    for (const { code, total } of sofaBySo.values()) {
      const model = (code.split("-")[0] || code).trim().toUpperCase() || "—";
      const e = sofaModelMap.get(model) ?? { setsSold: 0, valueSen: 0 };
      e.setsSold += 1;
      e.valueSen += total;
      sofaModelMap.set(model, e);
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

    // ---- Top fabrics + monthly fabric meters (consumption basis) ----
    const topFabrics = (fabTopRes.results ?? [])
      .map((r) => ({
        fabCode: r.fabCode ?? "—",
        fabName: r.fabName ?? "",
        meters: Number(r.meters) || 0,
        costSen: Number(r.costSen) || 0,
      }))
      .filter((f) => f.meters > 0)
      .slice(0, 8);
    const fabricMonthly = (fabMonthRes.results ?? [])
      .filter((r) => r.ym)
      .map((r) => ({ month: r.ym as string, meters: Number(r.meters) || 0 }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    const headByDept = (headRes.results ?? []).map((r) => ({
      dept: r.dept || "—",
      count: Number(r.n) || 0,
    }));

    return {
      production: {
        dailyCapacityMin,
        backlogMin,
        backlogDays,
        completedToday,
        activeJobs: Number(activeJobsRes?.n) || 0,
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
      topSellers,
      topFabrics,
      monthlySales,
      monthlyRevenue,
      fabricMonthly,
      employee: {
        activeHeadcount: headByDept.reduce((s, d) => s + d.count, 0),
        byDept: headByDept.sort((a, b) => b.count - a.count),
      },
    };
  });

  return c.json({ success: true, ...data });
});

export default app;
