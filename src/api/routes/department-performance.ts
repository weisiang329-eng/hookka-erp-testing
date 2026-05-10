// ---------------------------------------------------------------------------
// Department Performance KPI — admin endpoint for the /employees page's
// "Department Performance" tab.
//
// GET /api/department-performance?from=YYYY-MM-DD&to=YYYY-MM-DD
//                                 &departmentCode=FAB_CUT&category=SOFA
//
// Aggregates working-minutes vs production-minutes across a date range,
// optionally filtered by departmentCode and/or category (SOFA | BEDFRAME).
// Mirrors the JC dedup + WHE rollup pattern from /api/worker/team-stats
// (src/api/routes/worker.ts) but is admin-scoped, not leader-scoped.
//
// Auth: standard admin RBAC (workers:read) — same gate as the workers list.
// NOT the worker-token getWorker auth.
//
// Defaults: last 7 days inclusive of today when from/to omitted.
//
// Production-minutes formula (matches team-stats): for each completed/
// transferred JC matched by (departmentCode in scope × itemCategory in scope
// × completedDate in range), credit the JC's full actualMinutes ?? estMinutes
// ONCE per date (no double-count when multiple workers share the JC).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type WheRow = {
  workerId: string;
  date: string;
  departmentCode: string;
  category: string | null;
  hours: number | string | null;
};

type JobCardRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  pic1Id: string | null;
  pic2Id: string | null;
  completedDate: string | null;
  estMinutes: number | null;
  actualMinutes: number | null;
};

type PiecePicRow = {
  jobCardId: string;
  pic1Id: string | null;
  pic2Id: string | null;
};

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;

  // Date defaults — last 7 days inclusive of today.
  const today = new Date();
  const defaultTo = ymd(today);
  const sixDaysAgo = new Date(today.getTime() - 6 * 86400000);
  const defaultFrom = ymd(sixDaysAgo);
  const fromStr = (c.req.query("from") || defaultFrom).slice(0, 10);
  const toStr = (c.req.query("to") || defaultTo).slice(0, 10);

  const departmentCodeQ = (c.req.query("departmentCode") || "").trim();
  const departmentCode = departmentCodeQ.length > 0 ? departmentCodeQ : null;

  const categoryQRaw = (c.req.query("category") || "").trim().toUpperCase();
  const category =
    categoryQRaw === "SOFA" || categoryQRaw === "BEDFRAME"
      ? (categoryQRaw as "SOFA" | "BEDFRAME")
      : null;

  // ---- Per-date accumulators.
  type DayCell = {
    workingMinutes: number;
    productionMinutes: number;
  };
  const byDate = new Map<string, DayCell>();
  const ensure = (d: string): DayCell => {
    let cell = byDate.get(d);
    if (!cell) {
      cell = { workingMinutes: 0, productionMinutes: 0 };
      byDate.set(d, cell);
    }
    return cell;
  };

  // Worker-id union — workers with WHE rows in scope OR on completed JCs in
  // scope (legacy pic1/pic2 + piece_pics).
  const workerIds = new Set<string>();

  // ---- Working minutes: SUM(hours * 60) from working_hour_entries.
  {
    const where: string[] = ["date >= ?", "date <= ?"];
    const binds: unknown[] = [fromStr, toStr];
    if (departmentCode) {
      where.push("departmentCode = ?");
      binds.push(departmentCode);
    }
    if (category) {
      where.push("category = ?");
      binds.push(category);
    }
    const sql = `SELECT workerId, date, departmentCode, category, hours
                   FROM working_hour_entries
                  WHERE ${where.join(" AND ")}`;
    const wheRes = await c.var.DB.prepare(sql)
      .bind(...binds)
      .all<WheRow>();
    for (const r of wheRes.results ?? []) {
      const mins = Math.round((Number(r.hours) || 0) * 60);
      ensure(r.date).workingMinutes += mins;
      if (r.workerId) workerIds.add(r.workerId);
    }
  }

  // ---- Production minutes: completed/transferred JCs in [from, to], filtered
  // by departmentCode (if given) and (after PO join) by itemCategory (if given).
  // Dedup per JC — the JC's minutes are credited ONCE per its completedDate,
  // regardless of how many workers (legacy pic1/pic2 or piece_pics) are on it.
  {
    const where: string[] = [
      "status IN ('COMPLETED','TRANSFERRED')",
      "completedDate >= ?",
      "completedDate <= ?",
    ];
    const binds: unknown[] = [fromStr, toStr];
    if (departmentCode) {
      where.push("departmentCode = ?");
      binds.push(departmentCode);
    }
    const jcSql = `SELECT id, productionOrderId, departmentCode, pic1Id, pic2Id,
                          completedDate, estMinutes, actualMinutes
                     FROM job_cards
                    WHERE ${where.join(" AND ")}`;
    const jcRes = await c.var.DB.prepare(jcSql)
      .bind(...binds)
      .all<JobCardRow>();
    const candidateJcs = jcRes.results ?? [];

    // Resolve PO itemCategory in one batch so we can apply the category filter.
    const poIds = Array.from(
      new Set(
        candidateJcs
          .map((j) => j.productionOrderId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    const poCategoryById = new Map<string, string | null>();
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT id, itemCategory FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...poIds)
        .all<{ id: string; itemCategory: string | null }>();
      for (const row of r.results ?? []) {
        poCategoryById.set(row.id, row.itemCategory);
      }
    }

    // After category filter, pull piece_pics so we can union worker ids.
    const keptJcs = candidateJcs.filter((jc) => {
      if (!jc.completedDate) return false;
      if (category) {
        const cat = poCategoryById.get(jc.productionOrderId) ?? null;
        if (cat !== category) return false;
      }
      return true;
    });

    let allPics: PiecePicRow[] = [];
    if (keptJcs.length > 0) {
      const ids = keptJcs.map((j) => j.id);
      const ph = ids.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT jobCardId, pic1Id, pic2Id FROM piece_pics WHERE jobCardId IN (${ph})`,
      )
        .bind(...ids)
        .all<PiecePicRow>();
      allPics = r.results ?? [];
    }
    const picsByJc = new Map<string, PiecePicRow[]>();
    for (const p of allPics) {
      const arr = picsByJc.get(p.jobCardId) ?? [];
      arr.push(p);
      picsByJc.set(p.jobCardId, arr);
    }

    for (const jc of keptJcs) {
      const date = jc.completedDate as string;
      // Dedup per JC: credit its full minutes once for its completedDate.
      const mins = jc.actualMinutes ?? jc.estMinutes ?? 0;
      ensure(date).productionMinutes += mins;
      if (jc.pic1Id) workerIds.add(jc.pic1Id);
      if (jc.pic2Id) workerIds.add(jc.pic2Id);
      for (const p of picsByJc.get(jc.id) ?? []) {
        if (p.pic1Id) workerIds.add(p.pic1Id);
        if (p.pic2Id) workerIds.add(p.pic2Id);
      }
    }
  }

  // ---- Build daily array sorted ascending by date.
  const daily = Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cell]) => ({
      date,
      workingMinutes: cell.workingMinutes,
      productionMinutes: cell.productionMinutes,
      efficiencyPct:
        cell.workingMinutes > 0
          ? Math.round((cell.productionMinutes / cell.workingMinutes) * 100)
          : 0,
    }));

  const totalWorking = daily.reduce((s, r) => s + r.workingMinutes, 0);
  const totalProduction = daily.reduce((s, r) => s + r.productionMinutes, 0);

  return c.json({
    success: true,
    data: {
      range: { from: fromStr, to: toStr },
      departmentCode,
      category,
      totals: {
        workingMinutes: totalWorking,
        productionMinutes: totalProduction,
        efficiencyPct:
          totalWorking > 0
            ? Math.round((totalProduction / totalWorking) * 100)
            : 0,
        workerCount: workerIds.size,
      },
      daily,
    },
  });
});

export default app;
