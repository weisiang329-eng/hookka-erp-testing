// ---------------------------------------------------------------------------
// Dashboard revenue feed — Phase C #5 quick-win.
//
// Returns the last N months (default 12) of revenue from
// mv_revenue_by_month_by_org, scoped to the caller's active orgId.
//
// Why an MV: the homepage chart used to scan sales_orders + group on every
// load. At ~50k-row scale that's a 4-7 second query (see roadmap §5). The
// MV is pre-aggregated nightly by refresh_dashboard_mvs() and reduces the
// chart query to a ~12-row index lookup.
//
// Mounted at /api/dashboard/revenue from worker.ts. Auth-gated by the
// global authMiddleware; tenant-scoped by withOrgScope().
//
// Response shape (kept minimal so the chart consumer can `.map(r => ...)`):
//   {
//     success: true,
//     data: [
//       { month: "2026-04", revenueSen: 12345600, orderCount: 87 },
//       ...
//     ],
//     orgId: "hookka",
//     refreshedAt: null,    // reserved for "data as of" indicator (roadmap §5 acceptance)
//   }
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 60;

type RevenueRow = {
  month: string;
  revenueSen: number | string | null;
  orderCount: number | null;
};

// GET /api/dashboard/revenue?months=12
//
// Last N calendar months of revenue for the active tenant, oldest first
// (chart-friendly). Months without orders are omitted; the consumer fills
// gaps client-side if it wants a continuous x-axis.
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const monthsParam = parseInt(c.req.query("months") ?? "", 10);
  const months = Math.min(
    MAX_MONTHS,
    Math.max(1, Number.isFinite(monthsParam) ? monthsParam : DEFAULT_MONTHS),
  );

  // Order DESC, LIMIT N to keep the result set small even if the MV grows
  // many years deep, then reverse client-side via .reverse() so the chart
  // gets oldest-first. The unique (orgId, month) index makes this a tight
  // index-only scan.
  const res = await c.var.DB.prepare(
    `SELECT month, revenue_sen AS revenueSen, order_count AS orderCount
       FROM mv_revenue_by_month_by_org
      WHERE orgId = ?
      ORDER BY month DESC
      LIMIT ?`,
  )
    .bind(orgId, months)
    .all<RevenueRow>();

  const rows = (res.results ?? [])
    .map((r) => ({
      month: r.month,
      // postgres bigint can come through as a string — normalise to number
      // for the JSON payload; chart consumers can't divide a string.
      revenueSen:
        typeof r.revenueSen === "string"
          ? Number(r.revenueSen)
          : (r.revenueSen ?? 0),
      orderCount: r.orderCount ?? 0,
    }))
    .reverse();

  return c.json({
    success: true,
    data: rows,
    orgId,
    refreshedAt: null,
  });
});

export default app;
