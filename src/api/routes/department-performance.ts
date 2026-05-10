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
//
// Each daily row also returns drilldown arrays:
//   workers[] — per-worker working-minutes for that date (sorted desc)
//   jobs[]    — per-JC production-minutes for that date (deduped, sorted desc)
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
  wipLabel: string | null;
};

type PiecePicRow = {
  jobCardId: string;
  pic1Id: string | null;
  pic2Id: string | null;
};

type PoMetaRow = {
  id: string;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  itemCategory: string | null;
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
  type WorkerCell = { workerId: string; workingMinutes: number };
  type JobCell = {
    jobCardId: string;
    poNo: string | null;
    departmentCode: string;
    productCode: string;
    productName: string;
    wipLabel: string | null;
    sizeLabel: string | null;
    productionMinutes: number;
    workerIds: Set<string>;
  };
  type DayCell = {
    workingMinutes: number;
    productionMinutes: number;
    workersByWorker: Map<string, WorkerCell>;
    jobs: JobCell[];
  };
  const byDate = new Map<string, DayCell>();
  const ensure = (d: string): DayCell => {
    let cell = byDate.get(d);
    if (!cell) {
      cell = {
        workingMinutes: 0,
        productionMinutes: 0,
        workersByWorker: new Map(),
        jobs: [],
      };
      byDate.set(d, cell);
    }
    return cell;
  };

  // Worker-id union — workers with WHE rows in scope OR on completed JCs in
  // scope (legacy pic1/pic2 + piece_pics). Used both for the totals.workerCount
  // and as the input to the worker-name batch lookup.
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
      const day = ensure(r.date);
      day.workingMinutes += mins;
      if (r.workerId) {
        workerIds.add(r.workerId);
        const wc = day.workersByWorker.get(r.workerId);
        if (wc) {
          wc.workingMinutes += mins;
        } else {
          day.workersByWorker.set(r.workerId, {
            workerId: r.workerId,
            workingMinutes: mins,
          });
        }
      }
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
                          completedDate, estMinutes, actualMinutes, wipLabel
                     FROM job_cards
                    WHERE ${where.join(" AND ")}`;
    const jcRes = await c.var.DB.prepare(jcSql)
      .bind(...binds)
      .all<JobCardRow>();
    const candidateJcs = jcRes.results ?? [];

    // Resolve PO meta in one batch — itemCategory is needed for the category
    // filter; poNo / productCode / productName / sizeLabel are needed for the
    // jobs[] drilldown in each daily entry.
    const poIds = Array.from(
      new Set(
        candidateJcs
          .map((j) => j.productionOrderId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    const poMetaById = new Map<string, PoMetaRow>();
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT id, poNo, productCode, productName, sizeLabel, itemCategory
           FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...poIds)
        .all<PoMetaRow>();
      for (const row of r.results ?? []) {
        poMetaById.set(row.id, row);
      }
    }

    // After category filter, pull piece_pics so we can union worker ids.
    const keptJcs = candidateJcs.filter((jc) => {
      if (!jc.completedDate) return false;
      if (category) {
        const cat = poMetaById.get(jc.productionOrderId)?.itemCategory ?? null;
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
      const day = ensure(date);
      day.productionMinutes += mins;

      const jcWorkerIds = new Set<string>();
      if (jc.pic1Id) {
        workerIds.add(jc.pic1Id);
        jcWorkerIds.add(jc.pic1Id);
      }
      if (jc.pic2Id) {
        workerIds.add(jc.pic2Id);
        jcWorkerIds.add(jc.pic2Id);
      }
      for (const p of picsByJc.get(jc.id) ?? []) {
        if (p.pic1Id) {
          workerIds.add(p.pic1Id);
          jcWorkerIds.add(p.pic1Id);
        }
        if (p.pic2Id) {
          workerIds.add(p.pic2Id);
          jcWorkerIds.add(p.pic2Id);
        }
      }

      const meta = poMetaById.get(jc.productionOrderId);
      day.jobs.push({
        jobCardId: jc.id,
        poNo: meta?.poNo ?? null,
        departmentCode: jc.departmentCode ?? "",
        productCode: meta?.productCode ?? "",
        productName: meta?.productName ?? "",
        wipLabel: jc.wipLabel ?? null,
        sizeLabel: meta?.sizeLabel ?? null,
        productionMinutes: mins,
        workerIds: jcWorkerIds,
      });
    }
  }

  // ---- Resolve worker names in one batch.
  const workerNameById = new Map<string, string>();
  if (workerIds.size > 0) {
    const ids = Array.from(workerIds);
    const ph = ids.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT id, name FROM workers WHERE id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ id: string; name: string }>();
    for (const row of r.results ?? []) {
      workerNameById.set(row.id, row.name);
    }
  }

  // ---- Build daily array sorted ascending by date.
  const daily = Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cell]) => {
      const workers = Array.from(cell.workersByWorker.values())
        .map((w) => ({
          workerId: w.workerId,
          workerName: workerNameById.get(w.workerId) ?? "",
          workingMinutes: w.workingMinutes,
        }))
        .sort((a, b) => b.workingMinutes - a.workingMinutes);

      const jobs = cell.jobs
        .map((j) => ({
          jobCardId: j.jobCardId,
          poNo: j.poNo,
          departmentCode: j.departmentCode,
          productCode: j.productCode,
          productName: j.productName,
          wipLabel: j.wipLabel,
          sizeLabel: j.sizeLabel,
          productionMinutes: j.productionMinutes,
          workers: Array.from(j.workerIds).map((id) => ({
            id,
            name: workerNameById.get(id) ?? "",
          })),
        }))
        .sort((a, b) => b.productionMinutes - a.productionMinutes);

      return {
        date,
        workingMinutes: cell.workingMinutes,
        productionMinutes: cell.productionMinutes,
        efficiencyPct:
          cell.workingMinutes > 0
            ? Math.round((cell.productionMinutes / cell.workingMinutes) * 100)
            : 0,
        workers,
        jobs,
      };
    });

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
