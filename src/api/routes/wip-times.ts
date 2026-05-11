// ---------------------------------------------------------------------------
// /api/wip-times — WIP catalog with per-(wipLabel × dept × category) average
// production times.
//
// Aggregates job_cards by (wipLabel, departmentCode, itemCategory) and
// returns AVG(estMinutes) + JC count + last-completed date. Drives the
// /production/wip-times reference page where operators / planners pick a
// dept (or category) and see how long each WIP typically takes.
//
// Source choice: job_cards.estMinutes (NOT the BOM template) because the
// BOM is the canonical recipe but operators sometimes tweak per-JC
// estMinutes when planning a real run. The average over many JCs gives a
// stable real-world number that already reflects whatever overrides have
// landed.
//
// GET /api/wip-times?dept=FAB_SEW&category=SOFA
//   - dept: optional, UPPER_SNAKE. Narrows to that dept.
//   - category: optional, SOFA | BEDFRAME | ACCESSORY. Narrows by PO
//     itemCategory.
//   - Both optional. Either or both can be combined.
//
// Response: { success: true, data: WipTimeRow[] } sorted by avgMinutes
// descending (longest WIPs first — that's what planners scan for).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type WipTimeAggRow = {
  wipLabel: string;
  departmentCode: string;
  itemCategory: string | null;
  avgMinutes: number | string | null;
  jcCount: number | string | null;
  lastCompletedDate: string | null;
};

app.get("/", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;

  const orgId = getOrgId(c);

  const deptParam = (c.req.query("dept") || "").trim().toUpperCase();
  const dept = deptParam.length > 0 ? deptParam : null;

  const categoryParam = (c.req.query("category") || "")
    .trim()
    .toUpperCase();
  const category =
    categoryParam === "SOFA" ||
    categoryParam === "BEDFRAME" ||
    categoryParam === "ACCESSORY"
      ? categoryParam
      : null;

  // Aggregation predicates. estMinutes > 0 drops the zero-time placeholder
  // JCs that some bedframe sub-assemblies carry (e.g. a stub Webbing row
  // attached to a no-webbing model) — they'd otherwise sink the average.
  const where: string[] = [
    "jc.orgId = ?",
    "jc.wipLabel IS NOT NULL",
    "jc.wipLabel <> ''",
    "jc.estMinutes > 0",
  ];
  const bindings: unknown[] = [orgId];

  if (dept) {
    where.push("jc.departmentCode = ?");
    bindings.push(dept);
  }
  if (category) {
    where.push("po.itemCategory = ?");
    bindings.push(category);
  }

  // GROUP BY the three identity columns. AVG over estMinutes per group, then
  // ORDER BY the aggregated avg descending so the longest-running WIPs sit
  // on top (planners scan from worst → best). Postgres-specific NULLS LAST
  // is unnecessary here because the WHERE clause already drops null estMins.
  const sql = `
    SELECT
      jc.wipLabel AS wipLabel,
      jc.departmentCode AS departmentCode,
      po.itemCategory AS itemCategory,
      AVG(jc.estMinutes) AS avgMinutes,
      COUNT(*) AS jcCount,
      MAX(jc.completedDate) AS lastCompletedDate
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.productionOrderId
    WHERE ${where.join(" AND ")}
    GROUP BY jc.wipLabel, jc.departmentCode, po.itemCategory
    ORDER BY AVG(jc.estMinutes) DESC
  `;

  const result = await c.var.DB.prepare(sql)
    .bind(...bindings)
    .all<WipTimeAggRow>();

  const rows = (result.results ?? []).map((r) => ({
    wipLabel: r.wipLabel,
    departmentCode: r.departmentCode,
    itemCategory: r.itemCategory ?? "",
    avgMinutes: Math.round(Number(r.avgMinutes) || 0),
    jcCount: Number(r.jcCount) || 0,
    lastCompletedDate: r.lastCompletedDate,
  }));

  return c.json({ success: true, data: rows });
});

export default app;
