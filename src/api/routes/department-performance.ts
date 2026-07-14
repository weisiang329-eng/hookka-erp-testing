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
// Each daily row also returns a drilldown array:
//   workers[] — per-worker working / production / efficiency for that date,
//               plus the JCs that worker contributed to (pro-rated share).
//
// Production-minutes pro-ration: a JC's full minutes are divided EVENLY
// across the distinct worker ids credited to it (pic1 + pic2 on the JC plus
// any piece_pics rows). This way the SUM of per-worker productionMinutes
// for a date equals the date-level productionMinutes (modulo rounding), and
// efficiency at the worker level is comparable to efficiency at the date
// level — operator can drill from a low daily % straight to the worker(s)
// pulling the average down.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { jcMinutesTotal } from "../../lib/job-card-minutes";
import {
  writeEmployeeStateSnapshot,
  type EmployeeStateMetrics,
} from "../lib/employee-state-snapshot";

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
  // B3 fix companion (2026-05-11): wipQty needed so the audit's
  // per-unit → total multiplication can reach the row. SELECT below
  // must fetch it too.
  wipQty: number | null;
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

  // PR 7 — cache-aside snapshot. Snapshot row keyed by full param tuple
  // so different (date range × dept × category) combos don't collide.
  // Read-then-fallthrough pattern (vs withSnapshot wrap) keeps the
  // 360-line compute below at its original indent level.
  const { getOrgId } = await import("../lib/tenant");
  const { readSnapshot, writeSnapshot, getMaxSourceUpdatedAt, isSnapshotFresh } =
    await import("../lib/snapshot");
  const orgId = getOrgId(c);
  const snapConfig = {
    tableName: "department_performance_snapshot",
    // worker_nonprod_requests added 2026-06-27: ADD_PROD approvals now feed the
    // numerator (below), so a new/edited request must invalidate this cache.
    // (Probe uses its created_at — no updated_at column; the Layer-3 nightly
    // rebuild backstops any approval that reuses an existing created_at.)
    sourceTables: ["job_cards", "working_hour_entries", "worker_nonprod_requests", "production_orders", "workers"],
  };
  const cacheKey = `from=${fromStr}&to=${toStr}&dept=${departmentCode ?? ""}&cat=${category ?? ""}`;
  const _snap_check = await Promise.all([
    readSnapshot(c.var.DB, snapConfig, orgId, cacheKey),
    getMaxSourceUpdatedAt(c.var.DB, snapConfig),
  ]);
  if (isSnapshotFresh(_snap_check[0], _snap_check[1]) && _snap_check[0]) {
    return c.json({ success: true, ..._snap_check[0].data });
  }
  const _snap_currentMax = _snap_check[1];

  // ---- Per-date accumulators.
  type WorkerJobCell = {
    jobCardId: string;
    productCode: string;
    productName: string;
    wipLabel: string | null;
    poNo: string | null;
    productionMinutes: number;
  };
  type WorkerCell = {
    workerId: string;
    workingMinutes: number;
    productionMinutes: number;
    jobs: WorkerJobCell[];
  };
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

  // CANONICAL-denominator restriction (unified 2026-06-27). The efficiency
  // denominator must count ONLY isProduction departments — the same set
  // computeMonthlyEfficiencyByWorker / the Efficiency Overview use. When the
  // operator picks an explicit single department we keep THAT department (the
  // WHERE departmentCode = ? below already narrows it, and an explicit pick is
  // honoured even if it is non-production). But when NO department filter is
  // applied this endpoint previously summed ALL departments — including
  // Warehousing / Repair / Maintenance / Shortfall / R&D — inflating the
  // denominator and pulling efficiency below what the office Overview shows.
  // Fix: in the unfiltered case, restrict the WHE denominator to the
  // isProduction dept codes. Approved NONPROD hours already left the prod dept
  // (they land in a non-prod WHE row), so they fall out naturally here too.
  const productionDeptCodes = new Set<string>();
  {
    const deptRes = await c.var.DB.prepare(
      "SELECT code, isProduction FROM departments",
    )
      .bind()
      .all<{ code: string; isProduction: number | boolean | null }>();
    for (const d of deptRes.results ?? []) {
      if (d.isProduction) productionDeptCodes.add(d.code);
    }
  }

  // ---- Working minutes: SUM(hours * 60) from working_hour_entries.
  {
    const where: string[] = ["date >= ?", "date <= ?"];
    const binds: unknown[] = [fromStr, toStr];
    if (departmentCode) {
      where.push("departmentCode = ?");
      binds.push(departmentCode);
    } else if (productionDeptCodes.size > 0) {
      // No explicit dept filter → canonical denominator = isProduction depts only.
      const ph = Array.from(productionDeptCodes)
        .map(() => "?")
        .join(",");
      where.push(`departmentCode IN (${ph})`);
      binds.push(...productionDeptCodes);
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
            productionMinutes: 0,
            jobs: [],
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
                          completedDate, estMinutes, actualMinutes, wipLabel,
                          wipQty
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
      // B3 fix (2026-05-11): jc.estMinutes + jc.actualMinutes are both
      // per-UNIT (import-completion.ts:538 sets actual ← per-unit value).
      // Multiply by wipQty for the JC total — mirrors worker.ts:1475.
      // FAB_CUT exception (jcMinutesTotal): merged FABRIC CUTTING cards store
      // the per-SET total already (wipQty = piece count), so the helper skips
      // the ×wipQty there to avoid a 3× over-count in dept Production Minutes.
      const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
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

      // ---- Per-worker pro-rated share for THIS jc.
      // Mirrors /api/worker/history (worker.ts ~570-640): per-piece split when
      // piece_pics rows exist, otherwise legacy single-pic split on the JC
      // itself. Keyed against (estMinutes ?? actualMinutes) per task spec.
      const jcMins = jc.estMinutes ?? jc.actualMinutes ?? 0;
      const pieces = picsByJc.get(jc.id) ?? [];
      const perWorkerMins = new Map<string, number>();
      if (pieces.length > 0) {
        // Per-piece minute base. Non-FAB_CUT: jcMins is per-piece, so each
        // piece row credits jcMins (summed over pieces.length ≈ wipQty → JC
        // total). FAB_CUT stores the per-SET total on the JC (not per-piece),
        // so the per-piece base is total ÷ piece count — keeps the per-piece
        // sum equal to jcMinutesTotal instead of total × piece count (the 3×
        // over-count this fix removes). Mirrors the FAB_CUT branch in worker.ts.
        const perPieceMins =
          (jc.departmentCode ?? "") === "FAB_CUT"
            ? jcMinutesTotal(jcMins, jc) / Math.max(1, pieces.length)
            : jcMins;
        for (const s of pieces) {
          const picCount = (s.pic1Id ? 1 : 0) + (s.pic2Id ? 1 : 0);
          const share = perPieceMins / Math.max(1, picCount);
          if (s.pic1Id) {
            perWorkerMins.set(
              s.pic1Id,
              (perWorkerMins.get(s.pic1Id) ?? 0) + share,
            );
          }
          if (s.pic2Id) {
            perWorkerMins.set(
              s.pic2Id,
              (perWorkerMins.get(s.pic2Id) ?? 0) + share,
            );
          }
        }
      } else {
        // B3 fix: legacy path = no pieces, so jcMins (per-unit) needs
        // explicit × wipQty for total. Pieces path above is fine because
        // it iterates pieces.length × jcMins per worker = wipQty × jcMins.
        // jcMinutesTotal applies the ×wipQty for normal depts and skips it for
        // FAB_CUT (jcMins is already the per-SET total there).
        const picCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
        const share = jcMinutesTotal(jcMins, jc) / Math.max(1, picCount);
        if (jc.pic1Id) perWorkerMins.set(jc.pic1Id, share);
        if (jc.pic2Id) perWorkerMins.set(jc.pic2Id, share);
      }

      for (const [wid, rawMins] of perWorkerMins) {
        const myMins = Math.round(rawMins);
        let wc = day.workersByWorker.get(wid);
        if (!wc) {
          // Worker has JC credit but no working_hour_entries row for this date.
          // Surface them in workers[] anyway with workingMinutes=0.
          wc = {
            workerId: wid,
            workingMinutes: 0,
            productionMinutes: 0,
            jobs: [],
          };
          day.workersByWorker.set(wid, wc);
        }
        wc.productionMinutes += myMins;
        wc.jobs.push({
          jobCardId: jc.id,
          productCode: meta?.productCode ?? "",
          productName: meta?.productName ?? "",
          wipLabel: jc.wipLabel ?? null,
          poNo: meta?.poNo ?? null,
          productionMinutes: myMins,
        });
      }
    }
  }

  // ---- Approved EXTRA PRODUCTION TIME (kind='ADD_PROD') → NUMERATOR (unified
  // 2026-06-27). Same credit the canonical Efficiency Overview adds via
  // computeApprovedAddProdMinutesByWorker: an approved over-the-WIP-standard
  // claim counts as production output, so efficiency stays fair. Previously this
  // endpoint omitted it, reading low for any worker with approved extra time.
  //
  // worker_nonprod_requests.department_code on an ADD_PROD row is always a
  // PRODUCTION dept (enforced at create/approve), so these minutes are
  // denominator-consistent with the isProduction WHE filter above. We query the
  // rows directly (not the helper map) because the helper is not dept-aware and
  // this endpoint must respect an explicit single-department filter; the
  // UNFILTERED result is identical to computeApprovedAddProdMinutesByWorker
  // (every ADD_PROD dept is a production dept, all of them credited). The
  // category filter has no counterpart column on the request table, so ADD_PROD
  // is skipped when a category is selected (conservative — never cross-credits
  // SOFA extra-time onto a BEDFRAME view).
  if (!category) {
    try {
      const apWhere: string[] = [
        "kind = 'ADD_PROD'",
        "status = 'APPROVED'",
        "date >= ?",
        "date <= ?",
      ];
      const apBinds: unknown[] = [fromStr, toStr];
      if (departmentCode) {
        apWhere.push("department_code = ?");
        apBinds.push(departmentCode);
      }
      const apRes = await c.var.DB.prepare(
        `SELECT worker_id AS workerId, date, COALESCE(approved_hours, hours) AS hours
           FROM worker_nonprod_requests
          WHERE ${apWhere.join(" AND ")}`,
      )
        .bind(...apBinds)
        .all<{ workerId: string; date: string; hours: number | string | null }>();
      for (const r of apRes.results ?? []) {
        const wid = (r.workerId ?? "").trim();
        const d = (r.date ?? "").slice(0, 10);
        if (!wid || !d) continue;
        const h = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
        const mins = Math.round(h * 60);
        if (mins <= 0) continue;
        workerIds.add(wid);
        const day = ensure(d);
        day.productionMinutes += mins;
        let wc = day.workersByWorker.get(wid);
        if (!wc) {
          wc = {
            workerId: wid,
            workingMinutes: 0,
            productionMinutes: 0,
            jobs: [],
          };
          day.workersByWorker.set(wid, wc);
        }
        wc.productionMinutes += mins;
        // Surface as a drilldown line so the per-worker jobs sum equals the
        // worker's productionMinutes (parity with the JC rows above).
        wc.jobs.push({
          jobCardId: `addprod:${wid}:${d}`,
          productCode: "",
          productName: "Extra production time (approved)",
          wipLabel: null,
          poNo: null,
          productionMinutes: mins,
        });
      }
    } catch {
      // Table/column not present yet (cold isolate) → no extra credit; the
      // numbers fall back to the JC-only figure. Never 500 the KPI page.
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
          productionMinutes: w.productionMinutes,
          efficiencyPct:
            w.workingMinutes > 0
              ? Math.round((w.productionMinutes / w.workingMinutes) * 100)
              : 0,
          jobs: w.jobs
            .slice()
            .sort((a, b) => b.productionMinutes - a.productionMinutes),
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

  const _snap_payload = {
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
  };
  // PR 7 — write-back. Errors swallowed; cache is best-effort.
  try {
    await writeSnapshot(
      c.var.DB,
      snapConfig,
      orgId,
      _snap_payload,
      _snap_currentMax ?? new Date().toISOString(),
      cacheKey,
    );
  } catch (e) {
    console.warn("[department-performance-snapshot] write-back failed:", e);
  }

  // Employee state daily snapshot (2026-06-03). The Employees page state
  // metrics (Headcount / Working Minutes / Labor Cost / Efficiency) are
  // point-in-time counts not reconstructible for a PAST period from
  // current-state-only tables. Capture a daily row from now on, reusing the
  // totals this handler ALREADY computed — fire-and-forget via waitUntil so
  // the Employees page render is never slowed (no added compute, no added
  // fetch on the page). Idempotent on (org_id, snap_date).
  //
  // Only capture when this request reflects today's LIVE, FULL-SCOPE state:
  // the default unfiltered view ending today. A filtered (dept/category) or
  // past-range view must never be written back as "today's" snapshot.
  // labor_cost_sen is not computed by this handler → stored as 0 (additive
  // column; a future labor-cost-aware caller can populate it).
  // See src/api/lib/employee-state-snapshot.ts and
  // migrations-postgres/0146_employee_state_snapshots.sql.
  try {
    const isFullScope = !departmentCode && !category;
    const endsToday = toStr === defaultTo;
    if (isFullScope && endsToday) {
      const metrics: EmployeeStateMetrics = {
        activeHeadcount: workerIds.size,
        totalWorkingMinutes: totalWorking,
        laborCostSen: 0,
        avgEfficiencyPct:
          totalWorking > 0
            ? Math.round((totalProduction / totalWorking) * 100)
            : 0,
        range: { from: fromStr, to: toStr },
      };
      const write = writeEmployeeStateSnapshot(
        c.var.DB,
        orgId,
        defaultTo,
        metrics,
      ).catch((e) =>
        console.warn("[employee-state-snapshot] write failed:", e),
      );
      if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(write);
      else void write;
    }
  } catch (e) {
    console.warn("[employee-state-snapshot] capture skipped:", e);
  }

  return c.json({
    success: true,
    ..._snap_payload,
    // Preserve old shape: data field at top level (above).
    // The original return had `data: {...}` here too.
    ...{} as Record<string, never>,
  });
});

export default app;
