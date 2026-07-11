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
import { jcMinutesTotal } from "../../lib/job-card-minutes";
import { loadSoLinePriceIndex, priceForItem } from "../lib/do-value";
import { computeFabricNext30ByCategory } from "../lib/fabric-usage";
import {
  readSnapshot,
  writeSnapshot,
  getMaxSourceUpdatedAt,
  isSnapshotFresh,
} from "../lib/dashboard-snapshot";
import {
  writeStateSnapshot,
  readStateSnapshotForMonth,
  type DashboardStateMetrics,
} from "../lib/dashboard-state-snapshot";

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

  // Command Center month-awareness (2026-06-02). The state-snapshot widgets
  // — Backlog, Active Jobs, Workforce — are point-in-time counts, not sums
  // over the period, so they are NOT reconstructible for a PAST month from
  // current-state-only tables. We (1) capture a daily snapshot of those
  // counts from now on, (2) for a past month serve the stored snapshot when
  // one exists (truthful history), else serve the live value clearly tagged
  // as "live (no history)". The current month and All-time view always serve
  // live — the current value IS truthful for "now". `period` for past months
  // is lexically < the current month prefix (ISO YYYY-MM sorts chronologically).
  const todayISOTop = fmtISO(new Date());
  const currentMonthPrefix = todayISOTop.slice(0, 7);
  const isPastMonth = period !== "all" && period < currentMonthPrefix;

  // Extract the live STATE metrics from a computed overview payload and
  // upsert today's daily snapshot (idempotent on (org_id, snap_date)).
  // Fire-and-forget via waitUntil so it never slows the response. Only
  // called with a payload that reflects LIVE state (period=all or current
  // month) — a past-month payload may have its state widgets overridden
  // from an older snapshot, which must never be written back as "today".
  const captureTodayState = (payload: Record<string, unknown>): void => {
    try {
      const prod = (payload?.production ?? {}) as Record<string, unknown>;
      const emp = (payload?.employee ?? {}) as Record<string, unknown>;
      const aj = (prod.activeJobs ?? {}) as Record<string, unknown>;
      const metrics: DashboardStateMetrics = {
        backlogMin: Number(prod.backlogMin) || 0,
        backlogDays: Number(prod.backlogDays) || 0,
        backlogByDept: Array.isArray(prod.backlogByDept)
          ? (prod.backlogByDept as unknown[])
          : [],
        backlogGrandMin: Number(prod.backlogGrandMin) || 0,
        activeJobs: {
          bedframeUnits: Number(aj.bedframeUnits) || 0,
          sofaSets: Number(aj.sofaSets) || 0,
          byCustomer: Array.isArray(aj.byCustomer)
            ? (aj.byCustomer as unknown[])
            : [],
        },
        activeHeadcount: Number(emp.activeHeadcount) || 0,
      };
      const write = writeStateSnapshot(
        c.var.DB,
        orgId,
        todayISOTop,
        metrics,
      ).catch((e) =>
        console.warn("[dashboard-state-snapshot] write failed:", e),
      );
      if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(write);
      else void write;
    } catch (e) {
      console.warn("[dashboard-state-snapshot] capture skipped:", e);
    }
  };

  // PR 1 (2026-05-20) — read-through dashboard snapshot.
  //
  // Three-layer freshness model (see src/api/lib/dashboard-snapshot.ts
  // for the architecture write-up):
  //   1. dashboard_snapshot table — persisted across deploys, data-
  //      change-aware via the built_from column. Checked first.
  //   2. 60s KV cache (the existing `cached(...)` wrapper below) —
  //      smooths out within-minute repeats when the snapshot misses.
  //   3. Full compute — the 27-query path below, ~200ms cold.
  //
  // Snapshot is only used for the default `period=all` view. Specific
  // month filters skip the snapshot and run the compute (those reads
  // are rare — operator usually leaves it on "All").
  if (period === "all") {
    const [snap, currentMax] = await Promise.all([
      readSnapshot(c.var.DB, orgId),
      getMaxSourceUpdatedAt(c.var.DB),
    ]);
    if (isSnapshotFresh(snap, currentMax) && snap) {
      // Keep the daily state snapshot fresh even when the dashboard_snapshot
      // stays valid all day (so a quiet-data day still records its row).
      captureTodayState(snap.data);
      return c.json({ success: true, ...snap.data });
    }
  }

  const data = await cached(c, `dashboard:overview:${orgId}:v22:${period}`, 60, async () => {
    const db = c.var.DB;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // The two flow KPIs (Sales + Delivered) reflect the SELECTED period:
    //   - a specific month  → that month's total (reconstructible from the
    //     SO date / DO delivered date; all source rows load unfiltered),
    //   - All-time          → the cumulative total across every month.
    // Delivered is keyed on the DO dispatch date (when goods shipped) so the
    // dashboard agrees with the invoices, which are dated by dispatch.
    // The point-in-time state KPIs (Outstanding / Pending / Plant Load) are
    // NOT period-scoped — they always reflect "now" and are tagged live.
    const kpiAllTime = period === "all";
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
    // Last 30 days (for category-specific fabric Past-30 actuals).
    const last30StartISO = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() - 30);
      return fmtISO(d);
    })();

    // Month-window bounds for the rolling widgets that DO honour the
    // selected month (Revenue chart, Completed list, Daily Capacity).
    // `period` is already validated as "YYYY-MM" or "all" (line ~56).
    //   - All-time            → bounds unused (each widget keeps its own
    //                           rolling window: last 12 weeks / 7 days /
    //                           7 working days).
    //   - Current month       → [1st .. TODAY]. Owner request 2026-06-10
    //                           ("今天明明已经是 10 号了,为什么还没有呈现 10 号
    //                           的数据") — the chart/list must include the
    //                           in-progress day, not stop at yesterday.
    //                           Today's point simply grows as the day fills.
    //   - Past month          → [1st .. last calendar day of that month].
    const monthScope = (() => {
      if (period === "all") return null;
      const yr = Number(period.slice(0, 4));
      const mo = Number(period.slice(5, 7)); // 1-12
      const first = fmtISO(new Date(yr, mo - 1, 1));
      const lastDay = fmtISO(new Date(yr, mo, 0)); // day 0 of next month
      const todayISO = fmtISO(new Date(today));
      const end = isPastMonth
        ? lastDay
        : todayISO < lastDay
          ? todayISO
          : lastDay;
      return { start: first, end, lastDay };
    })();

    // Completed-widget date bounds (per widget 2 of the month-aware plan):
    //   - "Completed" headline keeps the live "yesterday" figure for
    //     all-time / current month; for a PAST month it shows that month's
    //     LAST day's completions (there is no "yesterday" inside history).
    //   - The per-day drill-down list spans last-7-days for all-time /
    //     current, or the whole selected month otherwise.
    const completedHeadlineDate =
      isPastMonth && monthScope ? monthScope.lastDay : yesterdayISO;
    const completedRangeStart = monthScope ? monthScope.start : last7StartISO;
    const completedRangeEnd = monthScope ? monthScope.end : yesterdayISO;

    // Public holidays (kv_config['public_holidays'], maintained on the
    // Employees → Public Holidays panel). Excluded from the working-day
    // window below so a 0-production holiday doesn't deflate the daily-
    // capacity average. Mirrors the Planning page. — Wei Siang 2026-05-29
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
          // Malformed list → behave as before (Sundays-only exclusion).
        }
      }
    }

    // Rolling 7 most-recent COMPLETE working days (Mon-Sat, EXCLUDING
    // Sundays AND public holidays), ending YESTERDAY — same window the
    // Planning page uses. This ALWAYS drives the Backlog "days of queue"
    // figure (`backlogDays`), which is a point-in-time state metric and is
    // therefore NOT re-scoped by the selected month. `guard` caps the
    // walk-back so a malformed holiday list can never spin.
    const rolling7Days: string[] = [];
    {
      const cur = new Date(today);
      cur.setDate(cur.getDate() - 1);
      let guard = 0;
      while (rolling7Days.length < 7 && guard < 130) {
        guard++;
        const iso = fmtISO(cur);
        if (cur.getDay() !== 0 && !holidaySet.has(iso)) rolling7Days.push(iso);
        cur.setDate(cur.getDate() - 1);
      }
    }
    const rolling7Set = new Set(rolling7Days);

    // Daily-Capacity widget window (Mon-Sat, EXCLUDING Sundays AND public
    // holidays). The widget's average divisor is `windowDays.length`.
    //   - All-time / current behaviour → identical to the rolling 7 above.
    //   - A selected month → every working day in that month within
    //     [monthScope.start .. monthScope.end] (end already clamped to
    //     yesterday for the current month). Divisor becomes that month's
    //     working-day COUNT, not a hardcoded 7.
    let windowDays: string[];
    if (monthScope) {
      windowDays = [];
      // Capacity averaging counts COMPLETE days only: the in-progress today is
      // excluded (it deflated the month average all day long — owner audit
      // 2026-07-11). monthScope.end itself stays "today" because the Completed
      // widgets DO want today's completions; only this divisor window differs.
      const capEnd =
        monthScope.end === fmtISO(new Date(today)) && !isPastMonth
          ? fmtISO(new Date(new Date(today).getTime() - 24 * 60 * 60 * 1000))
          : monthScope.end;
      const cur = new Date(`${monthScope.start}T00:00:00`);
      let guard = 0;
      while (fmtISO(cur) <= capEnd && guard < 40) {
        guard++;
        const iso = fmtISO(cur);
        if (cur.getDay() !== 0 && !holidaySet.has(iso)) windowDays.push(iso);
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      windowDays = rolling7Days;
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
      fabPast30CatRes,
      backlogJcRes,
      headRes,
    ] = await Promise.all([
      db
        .prepare(
          "SELECT status, departmentCode, estMinutes, actualMinutes, wipQty, completedDate, dueDate, pic1Id, pic2Id FROM job_cards WHERE orgId = ?",
        )
        .bind(orgId)
        .all<{
          status: string;
          departmentCode: string | null;
          estMinutes: number | null;
          actualMinutes: number | null;
          wipQty: number | null;
          completedDate: string | null;
          dueDate: string | null;
          pic1Id: string | null;
          pic2Id: string | null;
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
          // Owner 2026-06-27: scope spend to the SELECTED period (was hardcoded
          // to the current calendar month via monthStart, so it ignored the
          // dashboard period selector — June's spend showed even on 2026-04/05).
          `SELECT COALESCE(SUM(totalSen),0) AS v FROM purchase_orders WHERE orgId = ? AND status != 'CANCELLED'${kpiAllTime ? "" : ` AND substr(orderDate::text, 1, 7) = '${period}'`}`,
        )
        .bind(orgId)
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
            WHERE orgId = ? AND status != 'CANCELLED'${kpiAllTime ? "" : ` AND substr(orderDate::text, 1, 7) = '${period}'`}
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
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')${kpiAllTime ? "" : ` AND substr(cl.date::text, 1, 7) = '${period}'`}`,
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
              AND po.itemCategory NOT IN ('BEDFRAME','SOFA')${kpiAllTime ? "" : ` AND substr(cl.date::text, 1, 7) = '${period}'`}`,
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
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
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
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
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
            WHERE so.orgId = ? AND so.status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
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
      // join the fabric-cost-excl query uses). Carries the consumption
      // month (cl.date) so the headline figures (per-category Avg cost/m
      // + per-fabric "used") can be scoped to the selected period; the
      // JS rollup sums across months for All-time / the selected month.
      db
        .prepare(
          `SELECT po.itemCategory AS "cat", rm.itemCode AS "fabCode",
                  substr(cl.date::text, 1, 7) AS "ym",
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
            GROUP BY po.itemCategory, rm.itemCode, substr(cl.date::text, 1, 7)`,
        )
        .bind(orgId)
        .all<{
          cat: string;
          fabCode: string;
          ym: string | null;
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
        .bind(orgId, completedHeadlineDate)
        .all<{
          cat: string | null;
          customerName: string | null;
          units: number;
          sos: number;
        }>(),
      // Completed in the LAST 7 DAYS (or the selected month) — per
      // completion date, Bedframe units + Sofa sets (no customer split).
      // Same per_po gate.
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
        .bind(orgId, completedRangeStart, completedRangeEnd)
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
      // Category-specific Past-30-days actual fabric issued (RM_ISSUE
      // in the last 30 days), so Bedframe/Sofa Past-30 is correct
      // instead of the SKU total.
      db
        .prepare(
          `SELECT po.itemCategory AS "cat", rm.itemCode AS "fabCode",
                  COALESCE(SUM(cl.qty),0) AS "meters"
             FROM cost_ledger cl
             JOIN raw_materials rm ON rm.id = cl.itemId
             JOIN production_orders po ON po.id = cl.refId
            WHERE po.orgId = ? AND cl.type = 'RM_ISSUE'
              AND cl.refType = 'PRODUCTION_ORDER'
              AND rm.itemGroup IN ('${FABRIC_ITEM_GROUPS.join("','")}')
              AND po.itemCategory IN ('BEDFRAME','SOFA')
              AND substr(cl.date::text, 1, 10) >= ?
            GROUP BY po.itemCategory, rm.itemCode`,
        )
        .bind(orgId, last30StartISO)
        .all<{ cat: string; fabCode: string; meters: number }>(),
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
          // TEST accounts excluded (owner 2026-07-11): they are not real
          // headcount — same rule the Payroll queries use.
          "SELECT departmentCode AS dept, COUNT(*) AS n FROM workers WHERE status = 'ACTIVE' AND empNo NOT LIKE 'TEST%' GROUP BY departmentCode",
        )
        .all<{ dept: string; n: number }>(),
    ]);

    // ---- Production ----
    let capacityMin = 0; // capacity over the Daily-Capacity widget window
    let capacityMin7 = 0; // capacity over the rolling 7 working days (Backlog)
    const capByDay = new Map<string, number>();
    // Distinct workers (PIC1/PIC2 ids) credited on the job cards COMPLETED
    // each day — the denominator for the per-worker capacity figure in the
    // Daily Capacity drill-down. Same job-card set that feeds capByDay, so
    // capacity ÷ workers is internally consistent.
    const workersByDay = new Map<string, Set<string>>();
    for (const jc of jcRes.results ?? []) {
      // jcMinutesTotal applies ×wipQty for normal depts and skips it for
      // FAB_CUT (estMinutes/actualMinutes is already the per-SET total there),
      // so the capacity + backlog minutes aren't 3× inflated for FAB_CUT.
      const done = jc.status === "COMPLETED" || jc.status === "TRANSFERRED";
      if (done && jc.completedDate) {
        const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
        // Backlog "days of queue" always uses the rolling 7-working-day
        // capacity — it is a point-in-time state metric, never re-scoped.
        if (rolling7Set.has(jc.completedDate)) capacityMin7 += mins;
        if (windowSet.has(jc.completedDate)) {
          capacityMin += mins;
          capByDay.set(
            jc.completedDate,
            (capByDay.get(jc.completedDate) ?? 0) + mins,
          );
          let wset = workersByDay.get(jc.completedDate);
          if (!wset) {
            wset = new Set<string>();
            workersByDay.set(jc.completedDate, wset);
          }
          if (jc.pic1Id) wset.add(jc.pic1Id);
          if (jc.pic2Id) wset.add(jc.pic2Id);
        }
      }
      // (The old all-JC backlogMin accumulation was removed 2026-07-11: the
      // headline backlog now derives from backlogGrandMin — the per-dept,
      // PO-filtered SOFA+BEDFRAME total — so gauge == drill-down == Planning.)
    }
    // Widget divisor = the window's working-day count (7 for all-time /
    // current; the month's working days for a selected month). Guard the
    // empty-window case (e.g. the 1st of the current month, no complete day
    // yet) so we never divide by zero.
    const capacityDivisor = windowDays.length || 1;
    const dailyCapacityMin = Math.round(capacityMin / capacityDivisor);
    // Backlog days uses the rolling-7 capacity (state metric — unchanged by
    // the month selector). Divisor stays a fixed 7. The headline DAYS figure
    // itself is derived BELOW from backlogGrandMin (the per-dept, PO-filtered
    // SOFA+BEDFRAME total) so gauge == drill-down == Planning — the old
    // all-JC numerator made the gauge read higher than both (9.4d vs 9.1d,
    // owner tally audit 2026-07-11).
    // Daily Capacity drill-down: the widget window's working days, oldest
    // first (rolling 7 for all-time / current; the month for a selection).
    const capacityDays = [...windowDays]
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        minutes: capByDay.get(date) ?? 0,
        workers: workersByDay.get(date)?.size ?? 0,
      }));

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
        // r.dept is the JC's departmentCode; jcMinutesTotal skips the ×wipQty
        // for FAB_CUT (already a per-SET total) and applies it for every other
        // dept — keeps this per-dept backlog consistent with the cost cascade.
        const jc = { departmentCode: r.dept, wipQty: r.wipQty };
        if (
          (r.jcStatus === "COMPLETED" || r.jcStatus === "TRANSFERRED") &&
          r.completedDate &&
          rolling7Set.has(r.completedDate)
        ) {
          windowTotal += jcMinutesTotal(r.actualMinutes ?? r.estMinutes ?? 0, jc);
        }
        if (
          (r.poStatus === "IN_PROGRESS" || r.poStatus === "PENDING") &&
          r.jcStatus !== "COMPLETED" &&
          r.jcStatus !== "CANCELLED" &&
          r.jcStatus !== "TRANSFERRED"
        ) {
          const m = jcMinutesTotal(r.estMinutes ?? 0, jc);
          if ((r.cat ?? "").toUpperCase() === "SOFA") sofaMin += m;
          else if ((r.cat ?? "").toUpperCase() === "BEDFRAME")
            bedframeMin += m;
        }
      }
      const dailyCapMin = Math.round(windowTotal / 7);
      const totalMin = sofaMin + bedframeMin;
      // Div-zero guard (owner audit 2026-07-11): a dept with backlog but ZERO
      // completions in the rolling window used to divide by 1 MINUTE, showing
      // thousands of "days" and topping the bottleneck sort. backlogDays = null
      // now means "stalled — no recent throughput to measure against"; the FE
      // renders it as such instead of a fake number.
      const backlogDays =
        dailyCapMin > 0 ? Math.round((totalMin / dailyCapMin) * 10) / 10 : null;
      return {
        dept: name,
        sofaMin,
        bedframeMin,
        totalMin,
        dailyCapMin,
        backlogDays,
      };
    })
      .filter((d) => d.totalMin > 0 || d.dailyCapMin > 0)
      // null (stalled) sorts first — it IS a bottleneck flag, just not a number.
      .sort((a, b) => (b.backlogDays ?? Infinity) - (a.backlogDays ?? Infinity));
    const backlogGrandMin = backlogByDept.reduce(
      (s, d) => s + d.totalMin,
      0,
    );
    // Unified headline (owner tally audit 2026-07-11): SOFA+BEDFRAME work on
    // IN_PROGRESS/PENDING orders ÷ rolling-7 capacity — the SAME population
    // the drill-down table and the Planning page use.
    const backlogDailyCapacityMin = Math.round(capacityMin7 / 7);
    const backlogDays =
      backlogDailyCapacityMin > 0
        ? Math.round((backlogGrandMin / backlogDailyCapacityMin) * 10) / 10
        : 0;

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
    // Completed per day (no customer split). Fill every day so the list is
    // continuous (0 on idle days). Window = last 7 days for all-time /
    // current; the whole selected month otherwise.
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
    if (monthScope) {
      const cur = new Date(`${monthScope.start}T00:00:00`);
      let guard = 0;
      while (fmtISO(cur) <= monthScope.end && guard < 40) {
        guard++;
        const iso = fmtISO(cur);
        const v = compByDay.get(iso) ?? { bf: 0, sofa: 0 };
        completedLast7.push({
          date: iso,
          bedframeUnits: v.bf,
          sofaSets: v.sofa,
        });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
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
      // Ship-month basis: prefer the dispatch date (when goods physically
      // left the factory) over the delivered/sign-off date. The sign-off
      // (deliveredAt) is often back-filled late and bunches goods into the
      // wrong month; dispatch is the reliable "shipped" date and matches the
      // invoice date (invoices are dated by dispatch). Falls back to delivered
      // then created so nothing is dropped. (Wei Siang 2026-06-03.)
      const eff = d.dispatchedAt || d.deliveredAt || d.created_at || "";
      doInfo.set(d.id, {
        soId: d.salesOrderId ?? "",
        shipped: SHIPPED_DO_STATUSES.has(d.status),
        ym: String(eff).slice(0, 7),
      });
    }
    // SO confirm-month lookup (soId -> 'YYYY-MM' of companySODate) for the
    // month-cohort Order Pipeline: "of the orders CONFIRMED this month, how
    // much has shipped" — a same-cohort funnel that cannot exceed 100% (unlike
    // dispatch-month "delivered this month", which folds in prior-month backlog
    // and so overshoots confirmed). Built from the per-SO aggregate.
    const soConfirmYm = new Map<string, string>();
    for (const r of soAggRes.results ?? []) {
      if (r.soId && r.ym) soConfirmYm.set(String(r.soId), String(r.ym));
    }
    let thisMonthDeliveredSen = 0;
    let deliveredOfMonthOrdersSen = 0;
    for (const di of delivItemsRes.results ?? []) {
      const info = doInfo.get(di.deliveryOrderId);
      if (!info || !info.shipped) continue;
      const val =
        priceForItem(
          soPriceIdx,
          di.productionOrderId,
          info.soId,
          di.productCode,
        ) * (di.quantity || 0);
      // "Delivered this month" = shipped BY dispatch month (the KPI tile).
      if (kpiAllTime || info.ym === period) thisMonthDeliveredSen += val;
      // "Delivered of this month's orders" = the cohort funnel: shipped value
      // whose SO was CONFIRMED in the selected month, regardless of ship date.
      // Cohort key resolves PER ITEM: a CONSOLIDATED DO (header salesOrderId
      // NULL, many SOs on one truck) used to fall out of the funnel entirely,
      // understating the delivered % (owner audit 2026-07-11). The item's own
      // production order → SO link is authoritative; header SO is the fallback.
      const itemSoId =
        (di.productionOrderId
          ? soPriceIdx.poById.get(di.productionOrderId)?.salesOrderId
          : "") || info.soId;
      if (!kpiAllTime && soConfirmYm.get(itemSoId) === period) {
        deliveredOfMonthOrdersSen += val;
      }
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
    // Sales KPI = Σ confirmed-SO total for the selected month, or the
    // cumulative all-month total for All-time. soRevMap is built across all
    // months, so summing its values gives the lifetime confirmed-SO revenue.
    const thisMonthSalesSen = kpiAllTime
      ? [...soRevMap.values()].reduce((a, b) => a + b, 0)
      : (soRevMap.get(period) ?? 0);
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
    // Invoices KPI = Σ invoice total (excl CANCELLED) for the selected month,
    // by invoice date, or the cumulative all-month total for All-time. Same
    // source + month basis as the Invoices line of the Revenue chart, so the
    // Command Center "This Month Invoices" card reconciles with that line.
    // Mirrors thisMonthSalesSen (built from soRevMap) above.
    const invoicesThisMonthSen = kpiAllTime
      ? [...invRevMap.values()].reduce((a, b) => a + b, 0)
      : (invRevMap.get(period) ?? 0);
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

    // ── Weekly Revenue — same three lenses as monthlyRevenue but bucketed
    // by ISO week (Monday start). Additive queries so the monthly cards
    // above stay untouched. The three SO / Invoice / Production revenue
    // definitions mirror the monthly ones exactly so the two views
    // reconcile. — Wei Siang 2026-05-29.
    //
    // Date filtering only (the monetary logic is never touched):
    //   - All-time     → last 12 weeks: date >= date_trunc('week', today) - 11 weeks.
    //   - A month       → still weekly granularity, but ONLY rows whose date
    //     falls inside [monthScope.start .. monthScope.end]. Rows are still
    //     bucketed by their week-Monday, so a week that straddles the month
    //     boundary is keyed to its Monday (may sit a few days before the 1st).
    // `weekDateClause` returns the WHERE fragment for a given date column; the
    // matching bind values are appended per query.
    const weekDateClause = (col: string) =>
      monthScope
        ? `${col}::date >= ? AND ${col}::date <= ?`
        : `${col}::date >= (date_trunc('week', CURRENT_DATE) - INTERVAL '11 weeks')`;
    const weekDateBinds: string[] = monthScope
      ? [monthScope.start, monthScope.end]
      : [];
    // Bucket granularity for the Revenue chart:
    //   - A month selected → ONE bucket per calendar DAY (06-01, 06-02, …),
    //     so the chart plots every day of the month instead of ~2-5 coarse
    //     week points (the old weekly view made the partial last week look
    //     like a crash). — Wei Siang 2026-06-09.
    //   - All-time → UNCHANGED: bucket by ISO week-Monday.
    // Only the GROUP-BY date key changes here; the SUM/monetary expressions
    // and the (already month-scoped) `weekDateClause` WHERE filter are kept.
    const bucketExpr = (col: string) =>
      monthScope
        ? `to_char(${col}::date, 'YYYY-MM-DD')`
        : `to_char(date_trunc('week', ${col}::date), 'YYYY-MM-DD')`;
    const [soWeekRes, invWeekRes, prodWeekRes] = await Promise.all([
      db
        .prepare(
          `SELECT ${bucketExpr("companySODate")} AS "yw",
                  COALESCE(SUM(totalSen),0) AS "revenueSen"
             FROM sales_orders
            WHERE orgId = ? AND status NOT IN ('DRAFT','CANCELLED','ON_HOLD')
              AND companySODate IS NOT NULL
              AND ${weekDateClause("companySODate")}
            GROUP BY 1`,
        )
        .bind(orgId, ...weekDateBinds)
        .all<{ yw: string | null; revenueSen: number }>(),
      db
        .prepare(
          `SELECT ${bucketExpr("invoiceDate")} AS "yw",
                  COALESCE(SUM(totalSen),0) AS "revenueSen"
             FROM invoices
            WHERE orgId = ? AND status != 'CANCELLED' AND invoiceDate IS NOT NULL
              AND ${weekDateClause("invoiceDate")}
            GROUP BY 1`,
        )
        .bind(orgId, ...weekDateBinds)
        .all<{ yw: string | null; revenueSen: number }>(),
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
           SELECT ${bucketExpr("per_po.unit_completed_at")} AS "yw",
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
                    ON soi.salesOrderId = po.salesOrderId AND soi.lineNo = po.lineNo
             LEFT JOIN consignment_order_items coi
                    ON coi.consignmentOrderId = po.consignmentOrderId AND coi.lineNo = po.lineNo
            WHERE po.itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
              AND per_po.unit_completed_at IS NOT NULL
              AND ${weekDateClause("per_po.unit_completed_at")}
            GROUP BY 1`,
        )
        .bind(...weekDateBinds)
        .all<{ yw: string | null; revenueSen: number }>(),
    ]);
    const soRevWeekMap = new Map<string, number>();
    for (const r of soWeekRes.results ?? []) if (r.yw) soRevWeekMap.set(r.yw, Number(r.revenueSen) || 0);
    const invRevWeekMap = new Map<string, number>();
    for (const r of invWeekRes.results ?? []) if (r.yw) invRevWeekMap.set(r.yw, Number(r.revenueSen) || 0);
    const prodRevWeekMap = new Map<string, number>();
    for (const r of prodWeekRes.results ?? []) if (r.yw) prodRevWeekMap.set(r.yw, Number(r.revenueSen) || 0);
    // Buckets to display on the x-axis (UTC). These must line up exactly with
    // the SQL GROUP-BY key chosen by `bucketExpr` above.
    //   - All-time → Monday-anchored week starts: the 12 weeks ending the
    //     current week (matches Postgres date_trunc('week', …), Monday-based).
    //   - A month   → EVERY calendar day in [monthScope.start .. monthScope.end]
    //     (the SQL now buckets per day), so each day of the month is a point.
    const weekStarts: string[] = (() => {
      if (monthScope) {
        // One entry per day from start..end inclusive. `guard` (>31) caps the
        // walk so a malformed bound can never spin.
        const days: string[] = [];
        const cur = new Date(`${monthScope.start}T00:00:00Z`);
        const endUTC = new Date(`${monthScope.end}T00:00:00Z`);
        let guard = 0;
        while (cur <= endUTC && guard < 40) {
          guard++;
          days.push(cur.toISOString().slice(0, 10));
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
        return days;
      }
      const out: string[] = [];
      const mon = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const dow = mon.getUTCDay(); // 0=Sun..6=Sat
      mon.setUTCDate(mon.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); // this week's Monday
      for (let i = 11; i >= 0; i--) {
        const d = new Date(mon);
        d.setUTCDate(d.getUTCDate() - i * 7);
        out.push(d.toISOString().slice(0, 10));
      }
      return out;
    })();
    const weeklyRevenue = weekStarts.map((week) => ({
      week,
      salesOrderSen: soRevWeekMap.get(week) ?? 0,
      invoiceSen: invRevWeekMap.get(week) ?? 0,
      productionSen: prodRevWeekMap.get(week) ?? 0,
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
    // Category-correct Next-30 forecast (BOM, FAB_CUT jobs due ≤30d),
    // bucketed by the JC's PO category — so a bedframe fabric never
    // shows its demand under Sofa. Same engine as the Fab Cut page.
    const fabNext30Cat = await computeFabricNext30ByCategory(db);
    // Category-correct Past-30 actual issued (RM_ISSUE last 30 days).
    const fabPast30Cat = new Map<string, Map<string, number>>();
    for (const r of fabPast30CatRes.results ?? []) {
      const cat = (r.cat ?? "").toUpperCase();
      if (cat !== "BEDFRAME" && cat !== "SOFA") continue;
      let m = fabPast30Cat.get(cat);
      if (!m) {
        m = new Map();
        fabPast30Cat.set(cat, m);
      }
      m.set(r.fabCode ?? "", Number(r.meters) || 0);
    }
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
    // Used (categorised) per fabric, keyed by category. Scoped to the
    // selected period: All-time sums every month; a specific YYYY-MM keeps
    // only that month's RM_ISSUE rows. Rows now arrive split by month, so
    // accumulate (do NOT overwrite) — a fabric used across several months
    // would otherwise keep only its last month. The per-category Avg cost/m
    // headline and the per-fabric "Used" column both read this map.
    const fabUsedByCat = new Map<
      string,
      Map<string, { fabName: string; meters: number; costSen: number }>
    >();
    for (const r of fabTopRes.results ?? []) {
      const cat = (r.cat ?? "").toUpperCase();
      if (cat !== "BEDFRAME" && cat !== "SOFA") continue;
      // Honour the selected month for the headline; All-time keeps every row.
      if (!kpiAllTime && r.ym !== period) continue;
      let m = fabUsedByCat.get(cat);
      if (!m) {
        m = new Map();
        fabUsedByCat.set(cat, m);
      }
      const prev = m.get(r.fabCode ?? "");
      m.set(r.fabCode ?? "", {
        fabName: r.fabName ?? prev?.fabName ?? "",
        meters: (prev?.meters ?? 0) + (Number(r.meters) || 0),
        costSen: (prev?.costSen ?? 0) + (Number(r.costSen) || 0),
      });
    }
    // Per-category weighted avg fabric cost / meter (all issued to
    // that category): Σ cost ÷ Σ meters. A shared fabric contributes
    // only the portion actually issued to that category.
    const catAvgCostSen = (cat: string) => {
      let cost = 0;
      let mtr = 0;
      for (const v of (fabUsedByCat.get(cat) ?? new Map()).values()) {
        cost += v.costSen;
        mtr += v.meters;
      }
      return mtr > 0 ? Math.round(cost / mtr) : 0;
    };
    const bedframeAvgCostSen = catAvgCostSen("BEDFRAME");
    const sofaAvgCostSen = catAvgCostSen("SOFA");
    // Combined per-category list: every fabric with history OR upcoming
    // demand IN THAT CATEGORY. Past-30 / Next-30 are category-specific
    // (not SKU totals). Client toggles the ranking.
    const fabListByCat = (cat: string) => {
      const used: Map<
        string,
        { fabName: string; meters: number; costSen: number }
      > = fabUsedByCat.get(cat) ?? new Map();
      const next30 = fabNext30Cat.get(cat) ?? new Map<string, number>();
      const past30 = fabPast30Cat.get(cat) ?? new Map<string, number>();
      const codes = new Set<string>([...used.keys(), ...next30.keys()]);
      return [...codes]
        .map((code) => {
          const u = used.get(code);
          const fp = fabPrice.get(code);
          return {
            fabCode: code || "—",
            fabName: u?.fabName ?? "",
            meters: u?.meters ?? 0,
            costSen: u?.costSen ?? 0,
            past30Meters: Math.round(past30.get(code) ?? 0),
            next30Meters: Math.round(next30.get(code) ?? 0),
            buyAvgSen: fp?.avgSen ?? 0,
            buyMinSen: fp?.minSen ?? 0,
            buyMaxSen: fp?.maxSen ?? 0,
          };
        })
        .filter((f) => f.meters > 0 || f.next30Meters > 0)
        .sort(
          (a, b) =>
            b.meters - a.meters || b.next30Meters - a.next30Meters,
        )
        .slice(0, 25);
    };
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
      BEDFRAME: {
        list: fabListByCat("BEDFRAME"),
        monthly: fabMonthByCat("BEDFRAME"),
      },
      SOFA: {
        list: fabListByCat("SOFA"),
        monthly: fabMonthByCat("SOFA"),
      },
    };

    const headByDept = (headRes.results ?? []).map((r) => ({
      dept: r.dept || "—",
      count: Number(r.n) || 0,
    }));
    const activeHeadcount = headByDept.reduce((s, d) => s + d.count, 0);

    // ---- Command Center month-awareness — state widgets ----
    // The live values just computed (backlog / activeJobs / headcount) are
    // a point-in-time snapshot of NOW. For a PAST month they are NOT that
    // month's truth. If we have a captured daily snapshot covering the
    // selected past month, serve it (truthful history, no tag). Otherwise
    // serve the live values flagged as "live (no history)" so the operator
    // is never misled. All-time and the current month always serve live
    // (source=live, isHistorical=false → no tag).
    let stateProduction = {
      dailyCapacityMin,
      // backlogMin now reports the SAME population as backlogDays and the
      // drill-down (SOFA+BF on active orders) so "Xd · Yh" is one number pair.
      backlogMin: backlogGrandMin,
      backlogDays,
      activeJobs,
      completedYesterday,
      completedLast7,
      capacityDays,
      backlogByDept,
      backlogGrandMin,
    };
    let stateEmployee = {
      activeHeadcount,
      byDept: headByDept.sort((a, b) => b.count - a.count),
    };
    let stateSnapshot: {
      source: "live" | "snapshot" | "reconstructed";
      isHistorical: boolean;
      asOf: string | null;
    } = { source: "live", isHistorical: false, asOf: null };
    if (isPastMonth) {
      const snapRow = await readStateSnapshotForMonth(db, orgId, period);
      if (snapRow) {
        // Truthful history available → override the state widgets from the
        // snapshot and drop the "live" tag. Flow/sum sections (revenue,
        // top sellers, fabric, AOV…) are already period-scoped and untouched.
        const m = snapRow.metrics;
        stateProduction = {
          ...stateProduction,
          backlogMin: Number(m.backlogMin) || 0,
          backlogDays: Number(m.backlogDays) || 0,
          backlogByDept: Array.isArray(m.backlogByDept)
            ? (m.backlogByDept as typeof backlogByDept)
            : backlogByDept,
          backlogGrandMin: Number(m.backlogGrandMin) || 0,
          activeJobs: {
            bedframeUnits: Number(m.activeJobs?.bedframeUnits) || 0,
            sofaSets: Number(m.activeJobs?.sofaSets) || 0,
            byCustomer: Array.isArray(m.activeJobs?.byCustomer)
              ? (m.activeJobs.byCustomer as typeof activeJobs.byCustomer)
              : [],
          },
        };
        stateEmployee = {
          ...stateEmployee,
          activeHeadcount: Number(m.activeHeadcount) || 0,
        };
        stateSnapshot = {
          source: "snapshot",
          isHistorical: false,
          asOf: snapRow.snapDate,
        };
      } else {
        // No stored snapshot for this past month. Rather than serve TODAY's
        // live state mislabelled as history, reconstruct the STATE widgets
        // (Backlog + Workforce) as of the month's LAST day (M) from the
        // event-bearing tables, and tag them as a best-effort ESTIMATE.
        //
        // This is an APPROXIMATION, not a captured truth:
        //   • job_cards has NO creation timestamp (only completed_date,
        //     due_date, and updated_at — and updated_at moves on every write
        //     so it can't establish "existed by M"). We therefore proxy a
        //     job card's birth by its PRODUCTION ORDER's create date,
        //     substr(COALESCE(po.created_at, po.start_date),1,10) — created_at
        //     is a full ISO timestamp and start_date is date-only, so we take
        //     the date prefix to compare cleanly against M's YYYY-MM-DD. A job
        //     card cannot predate its own PO, so "PO created on/before M" is a
        //     sound lower bound for "the job existed by M". If BOTH PO dates are
        //     NULL (legacy rows with no recorded birth) we INCLUDE the card —
        //     an open, still-uncompleted card almost certainly predates a
        //     past month-end, and dropping it would understate the backlog.
        //   • Re-deriving each PO's exact in-progress state as of M is not
        //     attempted (Active Jobs stays on the live value — see below).
        const M = monthScope ? monthScope.lastDay : null;
        if (M) {
          // ---- Backlog as of M ----------------------------------------------
          // Pending-as-of-M job cards: existed by M (PO born on/before M, or
          // unknown birth), NOT completed by M (completedDate NULL or after M),
          // and neither the card nor its PO cancelled. We pull the per-card
          // category + the PO create/start dates so the reconstruction mirrors
          // the live backlogByDept shape (sofa/bedframe split per department).
          // We also pull cards COMPLETED *within the month* to rebuild each
          // department's daily capacity for that month (mirrors the live
          // per-dept `windowTotal/7`, but scoped to the month's own throughput
          // ÷ the month's working-day count).
          const reconRows =
            (
              await db
                .prepare(
                  `SELECT jc.departmentCode AS "dept", jc.status AS "jcStatus",
                          jc.estMinutes AS "estMinutes",
                          jc.actualMinutes AS "actualMinutes",
                          jc.wipQty AS "wipQty",
                          jc.completedDate AS "completedDate",
                          po.itemCategory AS "cat", po.status AS "poStatus",
                          substr(COALESCE(po.created_at, po.startDate)::text, 1, 10) AS "poBirth"
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
                  poBirth: string | null;
                }>()
            ).results ?? [];

          // Month working-day count (already excludes Sundays + holidays via
          // windowDays for a selected month) — the per-dept capacity divisor.
          const reconMonthWorkingDays = windowDays.length || 1;
          // "Completed within the month" = completion date inside the month
          // window the rolling widgets already use (windowSet for a month).
          const reconBacklogByDept = DEPARTMENTS.map(({ code, name }) => {
            let sofaMin = 0;
            let bedframeMin = 0;
            let monthCompletedMin = 0;
            for (const r of reconRows) {
              if (r.dept !== code) continue;
              // r.dept is the JC's departmentCode; jcMinutesTotal skips the
              // ×wipQty for FAB_CUT (already a per-SET total) and applies it
              // elsewhere, so the reconstructed month figures aren't inflated.
              const jc = { departmentCode: r.dept, wipQty: r.wipQty };
              // Month throughput for this dept → reconstructed daily capacity.
              if (
                (r.jcStatus === "COMPLETED" || r.jcStatus === "TRANSFERRED") &&
                r.completedDate &&
                windowSet.has(r.completedDate)
              ) {
                monthCompletedMin += jcMinutesTotal(r.actualMinutes ?? r.estMinutes ?? 0, jc);
              }
              // Pending as of M: existed by M (PO born on/before M, or unknown
              // birth), not completed by M, neither card nor PO cancelled.
              const existedByM = r.poBirth == null || r.poBirth <= M;
              const completedByM =
                r.completedDate != null && r.completedDate <= M;
              const pendingAsOfM =
                existedByM &&
                !completedByM &&
                r.jcStatus !== "CANCELLED" &&
                r.poStatus !== "CANCELLED";
              if (pendingAsOfM) {
                const m = jcMinutesTotal(r.estMinutes ?? 0, jc);
                if ((r.cat ?? "").toUpperCase() === "SOFA") sofaMin += m;
                else if ((r.cat ?? "").toUpperCase() === "BEDFRAME")
                  bedframeMin += m;
              }
            }
            const dailyCapMin = Math.round(
              monthCompletedMin / reconMonthWorkingDays,
            );
            const totalMin = sofaMin + bedframeMin;
            // Same div-zero guard as the live path: null = stalled, never a
            // 1-minute fallback (owner audit 2026-07-11).
            const backlogDays =
              dailyCapMin > 0
                ? Math.round((totalMin / dailyCapMin) * 10) / 10
                : null;
            return {
              dept: name,
              sofaMin,
              bedframeMin,
              totalMin,
              dailyCapMin,
              backlogDays,
            };
          })
            .filter((d) => d.totalMin > 0 || d.dailyCapMin > 0)
            .sort((a, b) => (b.backlogDays ?? Infinity) - (a.backlogDays ?? Infinity));
          const reconBacklogGrandMin = reconBacklogByDept.reduce(
            (s, d) => s + d.totalMin,
            0,
          );
          // Headline backlog days uses the MONTH's daily capacity (its actual
          // average throughput, already computed as `dailyCapacityMin`). Guard
          // the divide-by-zero (a month with no completed work).
          const reconBacklogDays =
            dailyCapacityMin > 0
              ? Math.round((reconBacklogGrandMin / dailyCapacityMin) * 10) / 10
              : 0;

          // ---- Workforce as of M --------------------------------------------
          // Headcount employed on M = hired on/before M AND still employed on
          // M. workers.join_date is the hire date (TEXT YYYY-MM-DD, since
          // 0001); workers.resigned_at is the LAST DAY of employment (TEXT,
          // since 0143_workers_resignation — "records the last day of
          // employment"), so a worker is still employed up to AND INCLUDING
          // resigned_at → keep them when resigned_at >= M. We count across ALL
          // statuses (ACTIVE / INACTIVE / RESIGNED) — current status is "now",
          // not M. NULL join_date = legacy worker with no recorded hire date →
          // treated as employed since forever (included), so headcount is never
          // understated by missing data. workers is NOT org-scoped (no org_id
          // column — see the live headcount query above), so no orgId filter.
          const reconHeadRows =
            (
              await db
                .prepare(
                  `SELECT departmentCode AS "dept", COUNT(*) AS "n"
                     FROM workers
                    WHERE (joinDate IS NULL OR joinDate <= ?)
                      AND (resignedAt IS NULL OR resignedAt >= ?)
                    GROUP BY departmentCode`,
                )
                .bind(M, M)
                .all<{ dept: string | null; n: number }>()
            ).results ?? [];
          const reconHeadByDept = reconHeadRows.map((r) => ({
            dept: r.dept || "—",
            count: Number(r.n) || 0,
          }));
          const reconActiveHeadcount = reconHeadByDept.reduce(
            (s, d) => s + d.count,
            0,
          );

          // Override ONLY the reconstructed widgets. Active Jobs stays on the
          // LIVE value: re-deriving each PO's in-progress state as of M would
          // need a full job-card-history replay and is materially riskier than
          // Backlog/Workforce, so it is intentionally left as-is and the
          // estimate tag (below) covers the whole state group.
          stateProduction = {
            ...stateProduction,
            backlogMin: reconBacklogGrandMin,
            backlogDays: reconBacklogDays,
            backlogByDept: reconBacklogByDept,
            backlogGrandMin: reconBacklogGrandMin,
          };
          stateEmployee = {
            ...stateEmployee,
            activeHeadcount: reconActiveHeadcount,
            byDept: reconHeadByDept.sort((a, b) => b.count - a.count),
          };
          stateSnapshot = {
            source: "reconstructed",
            isHistorical: true,
            asOf: M,
          };
        } else {
          // Should be unreachable (isPastMonth ⇒ monthScope is set), but keep
          // the old honest fallback if month bounds are somehow unavailable.
          stateSnapshot = { source: "live", isHistorical: true, asOf: null };
        }
      }
    }

    return {
      salesThisMonthSen: thisMonthSalesSen,
      deliveredThisMonthSen: thisMonthDeliveredSen,
      invoicesThisMonthSen,
      deliveredOfMonthOrdersSen,
      production: stateProduction,
      stateSnapshot,
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
        bedframe: bedframeAvgCostSen,
        sofa: sofaAvgCostSen,
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
      weeklyRevenue,
      period,
      salesMonths,
      employee: stateEmployee,
    };
  });

  // PR 1 (2026-05-20) — write-back to dashboard_snapshot for the next
  // read. Only for period=all (the dominant view); month-specific reads
  // skip the snapshot entirely. Errors are swallowed: the cache write
  // is a perf optimisation, not load-bearing. The user already has the
  // computed payload in `data` and gets it back via the c.json below.
  if (period === "all") {
    try {
      const currentMax = await getMaxSourceUpdatedAt(c.var.DB);
      // currentMax may be null on a brand-new install (every tracked
      // table empty). In that case use the wall-clock now as
      // built_from so the row gets a non-null timestamp.
      const builtFrom = currentMax ?? new Date().toISOString();
      await writeSnapshot(
        c.var.DB,
        orgId,
        data as Record<string, unknown>,
        builtFrom,
      );
    } catch (e) {
      console.warn("[dashboard-snapshot] write-back failed:", e);
    }
  }

  // Capture today's daily STATE snapshot (Backlog / Active Jobs / Workforce)
  // so future past-month views can show the true figure. Only when `data`
  // reflects LIVE state — i.e. NOT a past month (a past-month payload may
  // carry state widgets overridden from an older snapshot, which must never
  // be recorded as today). All-time and the current month both qualify.
  if (!isPastMonth) {
    captureTodayState(data as Record<string, unknown>);
  }

  return c.json({ success: true, ...data });
});

export default app;
