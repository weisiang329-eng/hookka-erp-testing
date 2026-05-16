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

  const data = await cached(c, `dashboard:overview:${orgId}:v4`, 60, async () => {
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
      aovRes,
      topSellRes,
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
          `SELECT supplierName AS name, COALESCE(SUM(totalSen),0) AS spendSen
             FROM purchase_orders
            WHERE orgId = ? AND status != 'CANCELLED'
            GROUP BY supplierName
            ORDER BY spendSen DESC
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
      // Per-SO primary category + value, confirmed orders only.
      db
        .prepare(
          `SELECT so.customerName AS customerName, so.totalSen AS totalSen,
                  CASE
                    WHEN SUM(CASE WHEN si.itemCategory = 'SOFA' THEN 1 ELSE 0 END) > 0 THEN 'SOFA'
                    WHEN SUM(CASE WHEN si.itemCategory = 'BEDFRAME' THEN 1 ELSE 0 END) > 0 THEN 'BEDFRAME'
                    ELSE 'ACCESSORY'
                  END AS cat
             FROM sales_orders so
             JOIN sales_order_items si ON si.salesOrderId = so.id
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
            GROUP BY so.id, so.customerName, so.totalSen`,
        )
        .bind(orgId)
        .all<{ customerName: string; totalSen: number; cat: string }>(),
      db
        .prepare(
          `SELECT si.itemCategory AS cat, si.productCode AS productCode,
                  MAX(si.productName) AS productName,
                  COALESCE(SUM(si.quantity),0) AS qtySold,
                  COALESCE(SUM(si.lineTotalSen),0) AS valueSen
             FROM sales_order_items si
             JOIN sales_orders so ON so.id = si.salesOrderId
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED')
            GROUP BY si.itemCategory, si.productCode`,
        )
        .bind(orgId)
        .all<{
          cat: string;
          productCode: string;
          productName: string;
          qtySold: number;
          valueSen: number;
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

    // ---- AOV by customer × category ----
    const aovMap = new Map<
      string,
      { bfSen: number; bfN: number; soSen: number; soN: number }
    >();
    for (const r of aovRes.results ?? []) {
      const name = r.customerName || "—";
      const e =
        aovMap.get(name) ?? { bfSen: 0, bfN: 0, soSen: 0, soN: 0 };
      if (r.cat === "SOFA") {
        e.soSen += Number(r.totalSen) || 0;
        e.soN++;
      } else if (r.cat === "BEDFRAME") {
        e.bfSen += Number(r.totalSen) || 0;
        e.bfN++;
      }
      aovMap.set(name, e);
    }
    const aovByCustomer = [...aovMap.entries()]
      .map(([customerName, e]) => ({
        customerName,
        bedframeAvgSen: e.bfN > 0 ? Math.round(e.bfSen / e.bfN) : 0,
        bedframeOrders: e.bfN,
        sofaAvgSen: e.soN > 0 ? Math.round(e.soSen / e.soN) : 0,
        sofaOrders: e.soN,
        totalSen: e.bfSen + e.soSen,
      }))
      .sort((a, b) => b.totalSen - a.totalSen)
      .slice(0, 12);

    // ---- Top sellers by category ----
    const sellersByCat: Record<
      string,
      { productCode: string; productName: string; qtySold: number; valueSen: number }[]
    > = { BEDFRAME: [], SOFA: [], ACCESSORY: [] };
    for (const r of topSellRes.results ?? []) {
      const cat = sellersByCat[r.cat] ? r.cat : "ACCESSORY";
      sellersByCat[cat].push({
        productCode: r.productCode ?? "",
        productName: r.productName ?? "",
        qtySold: Number(r.qtySold) || 0,
        valueSen: Number(r.valueSen) || 0,
      });
    }
    for (const k of Object.keys(sellersByCat)) {
      sellersByCat[k] = sellersByCat[k]
        .sort((a, b) => b.valueSen - a.valueSen)
        .slice(0, 5);
    }

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
      topSellers: sellersByCat,
      employee: {
        activeHeadcount: headByDept.reduce((s, d) => s + d.count, 0),
        byDept: headByDept.sort((a, b) => b.count - a.count),
      },
    };
  });

  return c.json({ success: true, ...data });
});

export default app;
