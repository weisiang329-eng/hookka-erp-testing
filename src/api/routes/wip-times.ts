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
  // Aggregated category: when a wipLabel runs across multiple categories
  // (rare — happens when the same physical sub-assembly is reused), SQL
  // returns the alphabetically first one. Treated as display-only; the
  // user filter applies via WHERE before grouping so it doesn't disagree
  // with the visible scope.
  itemCategory: string | null;
  // Multi-category badge — when GROUP BY emits more than one category for
  // the same (wipLabel, dept), STRING_AGG returns the comma-joined list.
  // Frontend can show "SOFA, BEDFRAME" instead of just the first.
  itemCategories: string | null;
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

  // Dedup-by-WIP per Wei Siang 2026-05-11 spec ("如果同样的WIP 就只显示一次").
  // GROUP BY the WIP identity (wipLabel × departmentCode). itemCategory used
  // to be a third grouping column but that double-counted WIPs that span
  // categories. Now it's display-only: MIN() picks the alphabetically first
  // for the badge, STRING_AGG returns the full distinct set so the UI can
  // show "SOFA, BEDFRAME" when a WIP straddles. The category filter still
  // applies in WHERE — so even though grouping is by (wipLabel × dept), the
  // resulting rows reflect only the scoped categories.
  //
  // AVG over estMinutes per group; ORDER BY aggregated avg descending so the
  // longest-running WIPs sit on top (planners scan from worst → best).
  // WHERE clause already drops null / zero estMins so NULLS LAST isn't
  // needed.
  const sql = `
    SELECT
      jc.wipLabel AS wipLabel,
      jc.departmentCode AS departmentCode,
      MIN(po.itemCategory) AS itemCategory,
      STRING_AGG(DISTINCT po.itemCategory, ', ' ORDER BY po.itemCategory) AS itemCategories,
      AVG(jc.estMinutes) AS avgMinutes,
      COUNT(*) AS jcCount,
      MAX(jc.completedDate) AS lastCompletedDate
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.productionOrderId
    WHERE ${where.join(" AND ")}
    GROUP BY jc.wipLabel, jc.departmentCode
    ORDER BY AVG(jc.estMinutes) DESC
  `;

  const result = await c.var.DB.prepare(sql)
    .bind(...bindings)
    .all<WipTimeAggRow>();

  const rows = (result.results ?? []).map((r) => ({
    wipLabel: r.wipLabel,
    departmentCode: r.departmentCode,
    itemCategory: r.itemCategory ?? "",
    // When a wipLabel runs across multiple categories the badge shows the
    // joined list ("SOFA, BEDFRAME"); single-category rows just get that
    // one value. Frontend treats both shapes identically.
    itemCategories: r.itemCategories ?? r.itemCategory ?? "",
    avgMinutes: Math.round(Number(r.avgMinutes) || 0),
    jcCount: Number(r.jcCount) || 0,
    lastCompletedDate: r.lastCompletedDate,
  }));

  return c.json({ success: true, data: rows });
});

export default app;
