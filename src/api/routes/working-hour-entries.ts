// ---------------------------------------------------------------------------
// D1-backed working_hour_entries route.
//
//   GET    /api/working-hour-entries?attendanceId=...
//   GET    /api/working-hour-entries?date=YYYY-MM-DD
//   GET    /api/working-hour-entries?workerId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET    /api/working-hour-entries/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET    /api/working-hour-entries/daily-breakdown?from=YYYY-MM-DD&to=YYYY-MM-DD
//   POST   /api/working-hour-entries                — create one entry
//   POST   /api/working-hour-entries/bulk            — replace all entries for an attendance
//   PUT    /api/working-hour-entries/:id             — update hours / category / notes
//   DELETE /api/working-hour-entries/:id
//
// One row per (attendance × department × category). Hours are decimal
// (e.g. 7.5). PRODUCTION_SHORTFALL / WAREHOUSING / REPAIR / MAINTENANCE are
// non-production depts; for those, category MUST be empty. For SOFA / BEDFRAME
// / ACCESSORY production depts, category is required. The bulk endpoint is
// the primary write path used by the Working Hours breakdown UI — it wipes
// the existing per-attendance rows and inserts the new ones in one shot, so
// the UI doesn't have to track which rows changed.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { ensureNonprodRequests } from "./worker";

const app = new Hono<Env>();

// authMiddleware stashes the resolved user id on the context via c.set('userId').
// Env.Variables only types DB / dbTimer, so read it through a loose cast (same
// pattern as routes/presence.ts).
function getUserId(c: Context<Env>): string {
  const id = (c as unknown as { get: (k: string) => unknown }).get("userId");
  return typeof id === "string" ? id : "";
}

type EntryRow = {
  id: string;
  attendanceId: string;
  workerId: string;
  date: string;
  departmentCode: string;
  category: string | null;
  hours: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

// Production departments — for these, category (SOFA / BEDFRAME / ACCESSORY)
// is required. Everything else (WAREHOUSING / REPAIR / MAINTENANCE /
// PRODUCTION_SHORTFALL) is non-production and must NOT carry a category.
// Exported: the punch auto-fill (api/lib/punch-autofill.ts) builds rows that
// must pass the SAME category rule this route enforces.
export const PRODUCTION_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);
export const VALID_CATEGORIES = new Set(["SOFA", "BEDFRAME", "ACCESSORY"]);

function rowToEntry(r: EntryRow) {
  return {
    id: r.id,
    attendanceId: r.attendanceId,
    workerId: r.workerId,
    date: r.date,
    departmentCode: r.departmentCode,
    category: r.category ?? "",
    hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
    notes: r.notes ?? "",
  };
}

function genId(): string {
  return `whe-${crypto.randomUUID().slice(0, 8)}`;
}

function genAttId(): string {
  return `att-${crypto.randomUUID().slice(0, 8)}`;
}

// Resolve (workerId, date) → attendance_records.id, auto-creating a PRESENT
// row if none exists. The flat Working Hours grid lets supervisors enter
// hours rows without first clocking the worker in — this helper makes that
// work transparently. Returns null if the worker doesn't exist.
async function resolveOrCreateAttendance(
  c: Context<Env>,
  workerId: string,
  date: string,
): Promise<{ id: string; employeeId: string; date: string } | null> {
  const existing = await c.var.DB
    .prepare("SELECT id, employeeId, date FROM attendance_records WHERE employeeId = ? AND date = ?")
    .bind(workerId, date)
    .first<{ id: string; employeeId: string; date: string }>();
  if (existing) return existing;

  const worker = await c.var.DB
    .prepare(
      "SELECT w.id, w.name, w.departmentCode, d.shortName as deptShortName FROM workers w LEFT JOIN departments d ON d.id = w.departmentId WHERE w.id = ?",
    )
    .bind(workerId)
    .first<{ id: string; name: string; departmentCode: string | null; deptShortName: string | null }>();
  if (!worker) return null;

  const id = genAttId();
  await c.var.DB
    .prepare(
      `INSERT INTO attendance_records (
         id, employeeId, employeeName, departmentCode, departmentName,
         date, clockIn, clockOut, status, workingMinutes, productionTimeMinutes,
         efficiencyPct, overtimeMinutes, deptBreakdown, notes
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'PRESENT', 0, 0, 0, 0, '[]', '')`,
    )
    .bind(
      id,
      worker.id,
      worker.name,
      worker.departmentCode ?? "",
      worker.deptShortName ?? "",
      date,
    )
    .run();
  return { id, employeeId: worker.id, date };
}

type EntryInput = {
  departmentCode?: unknown;
  category?: unknown;
  hours?: unknown;
  notes?: unknown;
};

function validateEntry(input: EntryInput): { ok: true; data: { departmentCode: string; category: string; hours: number; notes: string } } | { ok: false; error: string } {
  const departmentCode = typeof input.departmentCode === "string" ? input.departmentCode.trim() : "";
  if (!departmentCode) return { ok: false, error: "departmentCode required" };

  const rawCategory = typeof input.category === "string" ? input.category.trim().toUpperCase() : "";
  const isProduction = PRODUCTION_DEPTS.has(departmentCode);
  if (isProduction) {
    if (!rawCategory) return { ok: false, error: `category required for production dept ${departmentCode}` };
    if (!VALID_CATEGORIES.has(rawCategory))
      return { ok: false, error: `invalid category "${rawCategory}" — must be SOFA, BEDFRAME, or ACCESSORY` };
  } else if (rawCategory) {
    return { ok: false, error: `category not allowed for non-production dept ${departmentCode}` };
  }

  const hoursNum = typeof input.hours === "number" ? input.hours : Number(input.hours);
  if (!Number.isFinite(hoursNum) || hoursNum < 0) return { ok: false, error: "hours must be a non-negative number" };

  const notes = typeof input.notes === "string" ? input.notes : "";
  return { ok: true, data: { departmentCode, category: isProduction ? rawCategory : "", hours: hoursNum, notes } };
}

// ---------------------------------------------------------------------------
// GET /production-revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// "Production Revenue" — revenue is recognized the day each PRODUCTION ORDER
// (PO) finishes upholstery, NOT per-job_card. A single PO can spawn multiple
// PIECES (HB, Divan, Cushion, …) each tracked as its own UPHOLSTERY job_card.
// Counting per-job_card multi-counts revenue as each piece completes.
//
// Source of truth: `job_cards` (department_code = 'UPHOLSTERY'). The earlier
// fg_units approach (commit be6a455) had the right dedup intent but the wrong
// data source: `fg_units.upholsteredAt` / `packedAt` are not consistently set
// in production — operators jump statuses without writing those timestamps —
// while `job_cards.completedDate` IS reliably populated and is the same
// signal the Production Tracking screen renders.
//
// Per-PO dedup: GROUP BY productionOrderId across the PO's UPHOLSTERY job
// cards. Recognition date = MAX(completedDate) across that group (when the
// LAST piece finished). A bedframe with HB + Divan + Cushion still books
// revenue once, on the last piece's completion date.
//
// Quantity / total: `production_orders.quantity` is the number of physical
// units in the PO (e.g. PO for 2 bedframes → qty=2). Revenue per PO =
// unit_price × quantity.
//
// Price COALESCE chain: sales_order_items.unitPriceSen → products.basePriceSen
// → products.price1Sen → 0. SO line wins because it's the contract price the
// customer actually pays (catalog price misses promo/contract pricing).
//
// Edge cases:
//   - Job cards with NULL completedDate are excluded (no recognition date).
//   - Status filter: COMPLETED + TRANSFERRED. TRANSFERRED means the piece
//     moved past UPHOLSTERY (e.g. into PACKING) — still counts as upholstery
//     done.
//   - Window filter is on MAX(completedDate) so a PO straddling the boundary
//     gets attributed to its final piece's completion date.
//
// Response also includes a `rows` array — one entry per recognized PO — for
// the "Revenue Raw Data" audit table on the Labor Cost tab.
// ---------------------------------------------------------------------------
app.get("/production-revenue", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // Single SQL: per_po CTE collapses UPHOLSTERY job_cards to one row per PO
  // (recognition date = MAX completedDate of done JCs), then we join out to
  // PO/SO/SO line/product for qty/price/category/display. ORDER BY DESC so
  // the rows array is already sorted for the frontend table.
  //
  // Bug fix 2026-04-28: revenue was being recognized when *any* upholstery
  // JC completed for a PO, not when ALL of them did. A bedframe with HB
  // and Divan would book full revenue the moment Divan upholstery
  // finished, even with HB still WAITING - so SO-2604-325 booked RM 520
  // when only the Divan was done.
  //
  // Fix: GROUP BY across the PO's full upholstery JC set (no status
  // filter in WHERE), then HAVING requires done_uph = total_uph - i.e.
  // every upholstery JC must be COMPLETED or TRANSFERRED with a non-null
  // completedDate. Recognition date is the MAX completedDate of the
  // done JCs (which equals MAX overall once they are all done).
  const rowsRes = await c.var.DB
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
            AND MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN completedDate END) >= ?
            AND MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN completedDate END) <= ?
       )
       SELECT po.id                AS poId,
              per_po.unit_completed_at AS completedAt,
              po.productCode       AS productCode,
              po.productName       AS productName,
              po.customerName      AS customerName,
              COALESCE(po.salesOrderNo, po.companyCOId) AS soNo,
              po.quantity          AS qty,
              po.itemCategory      AS category,
              -- CO-aware unit price: SO line item OR CO line item OR
              -- product master fallback. Without the CO branch, every CO
              -- PO got 0 revenue contribution.
              COALESCE(
                soi.unitPriceSen,
                coi.unitPriceSen,
                (SELECT COALESCE(p.basePriceSen, p.price1Sen)
                   FROM products p
                  WHERE p.code = po.productCode
                  ORDER BY p.basePriceSen DESC NULLS LAST, p.id
                  LIMIT 1),
                0
              ) AS unitPriceSen
         FROM per_po
         JOIN production_orders po ON po.id = per_po.productionOrderId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN consignment_order_items coi
                ON coi.consignmentOrderId = po.consignmentOrderId
               AND coi.lineNo = po.lineNo
        WHERE po.itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
        ORDER BY per_po.unit_completed_at DESC`,
    )
    .bind(from, to)
    .all<{
      poId: string;
      completedAt: string;
      productCode: string | null;
      productName: string | null;
      customerName: string | null;
      soNo: string | null;
      qty: number | string | null;
      category: "SOFA" | "BEDFRAME" | "ACCESSORY";
      unitPriceSen: number | string | null;
    }>();

  const totals: Record<"SOFA" | "BEDFRAME" | "ACCESSORY", number> = {
    SOFA: 0,
    BEDFRAME: 0,
    ACCESSORY: 0,
  };
  // One row per PO: qty = production_orders.quantity, total = unit × qty.
  const rows: Array<{
    date: string;
    productCode: string;
    productName: string;
    category: "SOFA" | "BEDFRAME" | "ACCESSORY";
    qty: number;
    unitPriceSen: number;
    totalPriceSen: number;
    customerName: string;
    soNo: string;
  }> = [];

  // Collect normalized PO data for the dept-attribution pass below.
  type RecognizedPO = {
    poId: string;
    category: "SOFA" | "BEDFRAME" | "ACCESSORY";
    totalPriceSen: number;
  };
  const recognizedPOs: RecognizedPO[] = [];

  for (const r of rowsRes.results ?? []) {
    if (r.category !== "SOFA" && r.category !== "BEDFRAME" && r.category !== "ACCESSORY") continue;
    const unitPriceSen = Math.round(typeof r.unitPriceSen === "number" ? r.unitPriceSen : Number(r.unitPriceSen) || 0);
    const qty = Math.max(1, Math.round(typeof r.qty === "number" ? r.qty : Number(r.qty) || 1));
    const totalPriceSen = unitPriceSen * qty;
    totals[r.category] += totalPriceSen;
    recognizedPOs.push({ poId: r.poId, category: r.category, totalPriceSen });
    // completedAt may include time-of-day; the table only needs the date.
    const date = (r.completedAt ?? "").slice(0, 10);
    rows.push({
      date,
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      category: r.category,
      qty,
      unitPriceSen,
      totalPriceSen,
      customerName: r.customerName ?? "",
      soNo: r.soNo ?? "",
    });
  }

  // Per (departmentCode, category) revenue attribution — PROGRESSIVE.
  //
  // Spec from Wei Siang 2026-05-03: each dept JC's completion books its
  // minute-weighted slice of the PO selling price the moment that JC
  // reaches COMPLETED/TRANSFERRED — NOT when the PO's final UPHOLSTERY
  // step lands. Total Revenue (above) stays UPH-locked, so by design:
  //
  //   Σ Category Revenue ≥ Total Revenue
  //
  // …with the gap = work-in-progress POs whose dept slices have already
  // been earned but whose UPHOLSTERY JC hasn't completed yet. This is
  // intentional and lets ops see "we already produced X this period, even
  // if the booking won't land until UPH closes the loop."
  //
  // Period filter: each JC's completedDate must fall in [from, to].
  // Recognition is per-(PO, dept-JC), not per-PO.
  //
  // Slice formula: po_total_price × this_jc_minutes ÷ po_total_minutes
  //   - po_total_price = unitPriceSen × quantity (same COALESCE as Total
  //     Revenue, kept symmetric so a per-dept slice and the eventual UPH
  //     booking use the same denominator)
  //   - po_total_minutes = SUM of every JC's minutes for that PO across
  //     ALL departments (including JCs not yet completed) — keeps the
  //     denominator stable so the slices sum to po_total_price once every
  //     dept JC has eventually closed.
  //   - this_jc_minutes = COALESCE(productionTimeMinutes, estMinutes, 0)
  //     for the specific JC that just completed.
  // Multiple JCs for the same dept on one PO each contribute independently;
  // their slices sum to that dept's full share once they all complete.
  const byDeptCategory: Record<string, number> = {};

  // Pull every dept JC that completed in the window. Joined to the PO so
  // we can carry itemCategory + price-coalesce candidates in a single
  // round-trip and reuse the same products fallback as the Total Revenue
  // query above (productCode-based to handle sofa variant ids).
  const jcRes = await c.var.DB
    .prepare(
      // Double-quoted aliases so Postgres preserves camelCase. Unquoted
      // aliases fold to all-lowercase ("poId" → "poid") and the d1-compat
      // snake→camel transform can't resurrect them, so r.poId would land
      // undefined and the loop below would skip every row — Category
      // Revenue read as 0 in the breakdown table.
      `SELECT jc.productionOrderId AS "poId",
              jc.departmentCode    AS "deptCode",
              po.itemCategory      AS "category",
              po.quantity          AS "qty",
              COALESCE(jc.productionTimeMinutes, jc.estMinutes, 0) AS "jcMinutes",
              COALESCE(
                soi.unitPriceSen,
                coi.unitPriceSen,
                (SELECT COALESCE(p.basePriceSen, p.price1Sen)
                   FROM products p
                  WHERE p.code = po.productCode
                  ORDER BY p.basePriceSen DESC NULLS LAST, p.id
                  LIMIT 1),
                0
              ) AS "unitPriceSen"
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN consignment_order_items coi
                ON coi.consignmentOrderId = po.consignmentOrderId
               AND coi.lineNo = po.lineNo
        WHERE jc.status IN ('COMPLETED','TRANSFERRED')
          AND jc.completedDate IS NOT NULL
          AND jc.completedDate >= ?
          AND jc.completedDate <= ?
          AND po.itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')`,
    )
    .bind(from, to)
    .all<{
      poId: string;
      deptCode: string;
      category: "SOFA" | "BEDFRAME" | "ACCESSORY";
      qty: number | string | null;
      jcMinutes: number | string | null;
      unitPriceSen: number | string | null;
    }>();

  // PO total minutes = sum of every JC's minutes for the PO (regardless
  // of completion state). Cached so we can attribute every JC slice
  // against the same stable denominator, even as more JCs complete in
  // future periods.
  const touchedPoIds = Array.from(
    new Set((jcRes.results ?? []).map((r) => r.poId)),
  );
  const totalMinutesByPo = new Map<string, number>();
  if (touchedPoIds.length > 0) {
    const placeholders = touchedPoIds.map(() => "?").join(",");
    const totalsRes = await c.var.DB
      .prepare(
        // Same camelCase-preserving alias rule as the JC query above.
        `SELECT productionOrderId AS "productionOrderId",
                SUM(COALESCE(productionTimeMinutes, estMinutes, 0)) AS "totalMinutes"
           FROM job_cards
          WHERE productionOrderId IN (${placeholders})
          GROUP BY productionOrderId`,
      )
      .bind(...touchedPoIds)
      .all<{ productionOrderId: string; totalMinutes: number | string }>();
    for (const r of totalsRes.results ?? []) {
      totalMinutesByPo.set(r.productionOrderId, Number(r.totalMinutes) || 0);
    }
  }

  for (const r of jcRes.results ?? []) {
    if (r.category !== "SOFA" && r.category !== "BEDFRAME" && r.category !== "ACCESSORY") continue;
    if (!r.deptCode) continue;
    const totalMin = totalMinutesByPo.get(r.poId) ?? 0;
    if (totalMin <= 0) continue;
    const jcMin = Number(r.jcMinutes) || 0;
    if (jcMin <= 0) continue;
    const unitPriceSen = Math.round(
      typeof r.unitPriceSen === "number" ? r.unitPriceSen : Number(r.unitPriceSen) || 0,
    );
    const qty = Math.max(1, Math.round(typeof r.qty === "number" ? r.qty : Number(r.qty) || 1));
    const poTotalPriceSen = unitPriceSen * qty;
    const share = Math.round((poTotalPriceSen * jcMin) / totalMin);
    const key = `${r.deptCode}|${r.category}`;
    byDeptCategory[key] = (byDeptCategory[key] ?? 0) + share;
  }
  // Silence the unused-variable warning — recognizedPOs is still kept
  // populated above for the legacy `rows` audit + Total Revenue totals.
  void recognizedPOs;

  const data = {
    SOFA: totals.SOFA,
    BEDFRAME: totals.BEDFRAME,
    ACCESSORY: totals.ACCESSORY,
    totalSen: totals.SOFA + totals.BEDFRAME + totals.ACCESSORY,
    rows,
    byDeptCategory,
  };
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-worker totals + per-(worker × dept) breakdown for the date range.
// Backs the Efficiency Overview and Employee Performance KPIs in the
// Employees page so they reflect hours entered through the new flat
// Working Hours grid (which writes working_hour_entries with hours but
// only stub-creates a PRESENT attendance row with workingMinutes=0).
//
// Returns one entry per worker that has ANY working_hour_entries rows
// in the period:
//   { workerId, totalHours, byDept: { FAB_CUT: 9, ... }, daysWithEntries }
// ---------------------------------------------------------------------------
app.get("/summary", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // PR 7 — cache-aside snapshot.
  const { getOrgId: _getOrgIdSum } = await import("../lib/tenant");
  const _snapMod = await import("../lib/snapshot");
  const _orgIdSum = _getOrgIdSum(c);
  const _snapCfgSum = {
    tableName: "whe_summary_snapshot",
    sourceTables: ["working_hour_entries"],
  };
  const _cacheKeySum = `from=${from}&to=${to}`;
  const _checkSum = await Promise.all([
    _snapMod.readSnapshot(c.var.DB, _snapCfgSum, _orgIdSum, _cacheKeySum),
    _snapMod.getSourceSignature(c.var.DB, _snapCfgSum.sourceTables),
  ]);
  if (_snapMod.isSnapshotFresh(_checkSum[0], _checkSum[1].maxUpdatedAt, _checkSum[1].rowCount) && _checkSum[0]) {
    return c.json({ success: true, ..._checkSum[0].data });
  }
  const _currentMaxSum = _checkSum[1].maxUpdatedAt;
  const _sourceRowsSum = _checkSum[1].rowCount;

  // One query per (worker, dept) bucket — totals are derived in JS by
  // summing across each worker's bucket rows. distinct(date) per worker
  // gives the daysWithEntries count without a second round trip.
  // SELECT aliases use snake_case so Postgres preserves them through the
  // unquoted-identifier lowercase fold; postgres.js's transform.column.from
  // restores them to camelCase on the way back. Without the snake_case
  // hint, `AS dayCount` would return as `daycount` and r.dayCount would be
  // undefined.
  const rowsRes = await c.var.DB
    .prepare(
      `SELECT workerId,
              departmentCode,
              SUM(hours) AS hours,
              COUNT(DISTINCT date) AS day_count
         FROM working_hour_entries
        WHERE date >= ? AND date <= ?
        GROUP BY workerId, departmentCode`,
    )
    .bind(from, to)
    .all<{ workerId: string; departmentCode: string; hours: number | string; dayCount: number }>();

  // Worker-level distinct-day count is the union of distinct dates across
  // all that worker's dept buckets — can't sum the per-bucket dayCounts
  // (a worker logging both FAB_CUT and FAB_SEW on the same date would
  // double-count). Second tiny query keeps the math honest.
  const daysRes = await c.var.DB
    .prepare(
      `SELECT workerId, COUNT(DISTINCT date) AS day_count
         FROM working_hour_entries
        WHERE date >= ? AND date <= ?
        GROUP BY workerId`,
    )
    .bind(from, to)
    .all<{ workerId: string; dayCount: number }>();

  const daysByWorker = new Map<string, number>();
  for (const r of daysRes.results ?? []) {
    daysByWorker.set(r.workerId, Number(r.dayCount) || 0);
  }

  const byWorker = new Map<string, { workerId: string; totalHours: number; byDept: Record<string, number>; daysWithEntries: number }>();
  for (const r of rowsRes.results ?? []) {
    const hours = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
    let entry = byWorker.get(r.workerId);
    if (!entry) {
      entry = {
        workerId: r.workerId,
        totalHours: 0,
        byDept: {},
        daysWithEntries: daysByWorker.get(r.workerId) ?? 0,
      };
      byWorker.set(r.workerId, entry);
    }
    entry.byDept[r.departmentCode] = (entry.byDept[r.departmentCode] ?? 0) + hours;
    entry.totalHours += hours;
  }

  const data = Array.from(byWorker.values()).sort((a, b) => b.totalHours - a.totalHours);
  const _payloadSum = { data, total: data.length };
  try {
    await _snapMod.writeSnapshot(
      c.var.DB,
      _snapCfgSum,
      _orgIdSum,
      _payloadSum,
      _currentMaxSum ?? new Date().toISOString(),
      _cacheKeySum,
      _sourceRowsSum,
    );
  } catch (e) {
    console.warn("[whe-summary-snapshot] write-back failed:", e);
  }
  return c.json({ success: true, ..._payloadSum });
});

// ---------------------------------------------------------------------------
// GET /dept-category-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-(departmentCode, category) hour totals for the date range. Backs the
// Planning page's Efficiency Overview, which needs the real Working Hours
// figure (separate from the JC.actualMinutes self-report) so it can compute
// a meaningful efficiency = production minutes / working minutes.
//
// Non-production depts (WAREHOUSING / REPAIR / MAINTENANCE /
// PRODUCTION_SHORTFALL / R_AND_D) come through as category="" — kept in
// the response so a future view that wants to display them can, but the
// Planning page filters them out.
// ---------------------------------------------------------------------------
app.get("/dept-category-summary", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // PR 7 — cache-aside snapshot.
  const { getOrgId: _getOrgIdDC } = await import("../lib/tenant");
  const _snapModDC = await import("../lib/snapshot");
  const _orgIdDC = _getOrgIdDC(c);
  const _snapCfgDC = {
    tableName: "whe_dept_category_snapshot",
    sourceTables: ["working_hour_entries"],
  };
  const _cacheKeyDC = `from=${from}&to=${to}`;
  const _checkDC = await Promise.all([
    _snapModDC.readSnapshot(c.var.DB, _snapCfgDC, _orgIdDC, _cacheKeyDC),
    _snapModDC.getSourceSignature(c.var.DB, _snapCfgDC.sourceTables),
  ]);
  if (_snapModDC.isSnapshotFresh(_checkDC[0], _checkDC[1].maxUpdatedAt, _checkDC[1].rowCount) && _checkDC[0]) {
    return c.json({ success: true, ..._checkDC[0].data });
  }
  const _currentMaxDC = _checkDC[1].maxUpdatedAt;
  const _sourceRowsDC = _checkDC[1].rowCount;

  const res = await c.var.DB
    .prepare(
      `SELECT departmentCode,
              COALESCE(category, '') AS category,
              SUM(hours) AS hours
         FROM working_hour_entries
        WHERE date >= ? AND date <= ?
        GROUP BY departmentCode, COALESCE(category, '')`,
    )
    .bind(from, to)
    .all<{ departmentCode: string; category: string; hours: number | string }>();

  const buckets = (res.results ?? []).map((r) => ({
    departmentCode: r.departmentCode,
    category: r.category ?? "",
    hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
  }));

  const _payloadDC = {
    data: { range: { from, to }, buckets },
  };
  try {
    await _snapModDC.writeSnapshot(
      c.var.DB,
      _snapCfgDC,
      _orgIdDC,
      _payloadDC,
      _currentMaxDC ?? new Date().toISOString(),
      _cacheKeyDC,
      _sourceRowsDC,
    );
  } catch (e) {
    console.warn("[whe-dept-category-snapshot] write-back failed:", e);
  }
  return c.json({ success: true, ..._payloadDC });
});

// ---------------------------------------------------------------------------
// GET /daily-breakdown?from=YYYY-MM-DD&to=YYYY-MM-DD[&category=SOFA|BEDFRAME|ACCESSORY]
//
// Per-day rollups for the Labor Cost vs Revenue tab's "Daily Breakdown" table.
// Returns three date-keyed maps:
//   - orderValueByDate:       sum of sales_orders.totalSen by companySODate
//                             (when ?category is set, narrows to SO line items
//                             whose product category matches)
//   - productionValueByDate:  sum of production-revenue per PO (price × qty)
//                             keyed on the LAST UPHOLSTERY job_card's
//                             completedDate — same dedup logic as the
//                             /production-revenue endpoint above
//   - unitsCompletedByDate:   COUNT of UPHOLSTERY job_cards with status
//                             COMPLETED|TRANSFERRED whose completedDate is
//                             in range
//
// Optional ?category= filter scopes everything to a single product category.
// When absent → unfiltered (all categories) — current behavior.
//
// Labor cost is intentionally NOT computed here: it depends on per-worker
// basic salary + OT multiplier which are easier to keep in the frontend
// (it already has them via the workers prop) and the per-worker pro-rata
// OT split is already implemented there. The frontend filters labor cost
// by entry.category against the same ?category param.
//
// Output values are in sen (raw integer, /100 in UI).
// ---------------------------------------------------------------------------
app.get("/daily-breakdown", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rawCat = (c.req.query("category") ?? "").trim().toUpperCase();
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : "";
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // 1. Order value — sum sales_orders.totalSen grouped by companySODate.
  //    Use companySODate (the date the SO was opened on the company side)
  //    so the chart matches the Sales reports view.
  //    With ?category set: drop the parent-SO total approach (which would
  //    over-count mixed-category SOs) and instead sum sales_order_items.
  //    lineTotalSen WHERE soi.itemCategory = ?, bucketed by the parent SO's
  //    companySODate. Uses sales_order_items.itemCategory directly — both
  //    `sales_order_items` and `products` carry the column, but the SO line
  //    is what was actually sold (and is the canonical source for the sale).
  // CO-aware: Order Value = (sales_orders + consignment_orders) per the
  // companySODate / companyCODate axis. Without the CO branch, every CO
  // contributed 0 to the chart and the Category Revenue split was
  // wrong for any tenant that runs consignment alongside retail.
  const orderValueRes = category
    ? await c.var.DB
        .prepare(
          `SELECT d, SUM(v) AS v FROM (
             SELECT so.companySODate AS d,
                    SUM(COALESCE(soi.lineTotalSen, 0)) AS v
               FROM sales_order_items soi
               JOIN sales_orders so ON so.id = soi.salesOrderId
              WHERE so.companySODate IS NOT NULL
                AND so.companySODate != ''
                AND so.companySODate >= ?
                AND so.companySODate <= ?
                AND soi.itemCategory = ?
              GROUP BY so.companySODate
             UNION ALL
             SELECT co.companyCODate AS d,
                    SUM(COALESCE(coi.lineTotalSen, 0)) AS v
               FROM consignment_order_items coi
               JOIN consignment_orders co ON co.id = coi.consignmentOrderId
              WHERE co.companyCODate IS NOT NULL
                AND co.companyCODate != ''
                AND co.companyCODate >= ?
                AND co.companyCODate <= ?
                AND coi.itemCategory = ?
              GROUP BY co.companyCODate
           ) u
           GROUP BY d`,
        )
        .bind(from, to, category, from, to, category)
        .all<{ d: string; v: number | string | null }>()
    : await c.var.DB
        .prepare(
          `SELECT d, SUM(v) AS v FROM (
             SELECT companySODate AS d, SUM(totalSen) AS v
               FROM sales_orders
              WHERE companySODate IS NOT NULL
                AND companySODate != ''
                AND companySODate >= ?
                AND companySODate <= ?
              GROUP BY companySODate
             UNION ALL
             SELECT companyCODate AS d, SUM(totalSen) AS v
               FROM consignment_orders
              WHERE companyCODate IS NOT NULL
                AND companyCODate != ''
                AND companyCODate >= ?
                AND companyCODate <= ?
              GROUP BY companyCODate
           ) u
           GROUP BY d`,
        )
        .bind(from, to, from, to)
        .all<{ d: string; v: number | string | null }>();

  // 2. Production value — same per-PO recognition as /production-revenue.
  //    GROUP BY productionOrderId, recognition date = MAX(completedDate),
  //    revenue = unitPrice × po.quantity. Then aggregate again by date.
  //    With ?category set, narrow to products of that category.
  //    Bug fix 2026-04-28: requires ALL upholstery JCs done (not just one)
  //    - same fix as /production-revenue. See that endpoint for rationale.
  const prodValueRes = await c.var.DB
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
            AND MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN completedDate END) >= ?
            AND MAX(CASE WHEN status IN ('COMPLETED','TRANSFERRED')
                              AND completedDate IS NOT NULL
                         THEN completedDate END) <= ?
       )
       SELECT substr(per_po.unit_completed_at, 1, 10) AS d,
              SUM(COALESCE(soi.unitPriceSen, coi.unitPriceSen, p.basePriceSen, p.price1Sen, 0)
                  * MAX(1, COALESCE(po.quantity, 1))) AS v
         FROM per_po
         JOIN production_orders po ON po.id = per_po.productionOrderId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN consignment_order_items coi
                ON coi.consignmentOrderId = po.consignmentOrderId
               AND coi.lineNo = po.lineNo
         LEFT JOIN products p ON p.id = po.productId
        WHERE p.category IN ('SOFA','BEDFRAME','ACCESSORY')
          ${category ? "AND p.category = ?" : ""}
        GROUP BY substr(per_po.unit_completed_at, 1, 10)`,
    )
    .bind(...(category ? [from, to, category] : [from, to]))
    .all<{ d: string; v: number | string | null }>();

  // 3. Units completed — count UPHOLSTERY job_cards completed in range.
  //    Per spec, this is "count of UPHOLSTERY job-cards completed on
  //    that day" — NOT a per-PO dedup, just a raw count of the cards.
  //    With ?category set, filter via the parent PO's itemCategory column.
  const unitsRes = await c.var.DB
    .prepare(
      `SELECT jc.completedDate AS d, COUNT(*) AS n
         FROM job_cards jc
         ${category ? "JOIN production_orders po ON po.id = jc.productionOrderId" : ""}
        WHERE jc.departmentCode = 'UPHOLSTERY'
          AND jc.status IN ('COMPLETED','TRANSFERRED')
          AND jc.completedDate IS NOT NULL
          AND jc.completedDate >= ?
          AND jc.completedDate <= ?
          ${category ? "AND po.itemCategory = ?" : ""}
        GROUP BY jc.completedDate`,
    )
    .bind(...(category ? [from, to, category] : [from, to]))
    .all<{ d: string; n: number | string | null }>();

  const orderValueByDate: Record<string, number> = {};
  for (const r of orderValueRes.results ?? []) {
    if (!r.d) continue;
    orderValueByDate[r.d] = Math.round(Number(r.v) || 0);
  }
  const productionValueByDate: Record<string, number> = {};
  for (const r of prodValueRes.results ?? []) {
    if (!r.d) continue;
    productionValueByDate[r.d] = Math.round(Number(r.v) || 0);
  }
  const unitsCompletedByDate: Record<string, number> = {};
  for (const r of unitsRes.results ?? []) {
    if (!r.d) continue;
    unitsCompletedByDate[r.d] = Number(r.n) || 0;
  }

  return c.json({
    success: true,
    data: {
      orderValueByDate,
      productionValueByDate,
      unitsCompletedByDate,
    },
  });
});

// ---------------------------------------------------------------------------
// GET — three query modes (attendanceId | date | workerId+from+to)
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const attendanceId = c.req.query("attendanceId");
  const date = c.req.query("date");
  const workerId = c.req.query("workerId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  let stmt;
  if (attendanceId) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE attendanceId = ? ORDER BY departmentCode, category",
    ).bind(attendanceId);
  } else if (workerId && from && to) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE workerId = ? AND date >= ? AND date <= ? ORDER BY date, departmentCode",
    ).bind(workerId, from, to);
  } else if (date) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE date = ? ORDER BY workerId, departmentCode",
    ).bind(date);
  } else if (from && to) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM working_hour_entries WHERE date >= ? AND date <= ? ORDER BY date, workerId, departmentCode",
    ).bind(from, to);
  } else {
    return c.json({ success: false, error: "Provide attendanceId, date, or (from + to [+ workerId])" }, 400);
  }

  const res = await stmt.all<EntryRow>();
  const data = (res.results ?? []).map(rowToEntry);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST / — create one entry
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "attendance", "create");
  if (denied) return denied;
  let body: { attendanceId?: unknown; workerId?: unknown; date?: unknown } & EntryInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  // Two ways to attribute an entry to its parent attendance row:
  //   - explicit attendanceId (legacy / direct), OR
  //   - workerId + date — server auto-resolves to the existing attendance
  //     row, or auto-creates a PRESENT row if the worker hasn't been
  //     clocked-in yet for that date. This is the path used by the new
  //     flat Working Hours grid: supervisors enter (worker × dept × cat ×
  //     hours) directly without first opening an attendance row.
  let att: { id: string; employeeId: string; date: string } | null = null;
  const explicitAttId = typeof body.attendanceId === "string" ? body.attendanceId : "";
  if (explicitAttId) {
    att = await c.var.DB
      .prepare("SELECT id, employeeId, date FROM attendance_records WHERE id = ?")
      .bind(explicitAttId)
      .first<{ id: string; employeeId: string; date: string }>();
    if (!att) return c.json({ success: false, error: "Attendance record not found" }, 400);
  } else {
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const date = typeof body.date === "string" ? body.date : "";
    if (!workerId || !date) {
      return c.json({ success: false, error: "Provide attendanceId, or workerId + date" }, 400);
    }
    att = await resolveOrCreateAttendance(c, workerId, date);
    if (!att) return c.json({ success: false, error: "Worker not found" }, 400);
  }

  const v = validateEntry(body);
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);

  const id = genId();
  await c.var.DB.prepare(
    `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      att.id,
      att.employeeId,
      att.date,
      v.data.departmentCode,
      v.data.category || null,
      v.data.hours,
      v.data.notes,
    )
    .run();

  const row = await c.var.DB.prepare("SELECT * FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return c.json({ success: true, data: rowToEntry(row!) }, 201);
});

// ---------------------------------------------------------------------------
// POST /bulk — replace all entries for an attendance row in one transaction.
// Body: { attendanceId | (workerId + date), entries: [{ departmentCode, category, hours, notes }] }
// ---------------------------------------------------------------------------
app.post("/bulk", async (c) => {
  const denied = await requirePermission(c, "attendance", "create");
  if (denied) return denied;
  let body: { attendanceId?: unknown; workerId?: unknown; date?: unknown; entries?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  if (!Array.isArray(body.entries)) return c.json({ success: false, error: "entries must be an array" }, 400);

  let att: { id: string; employeeId: string; date: string } | null = null;
  const explicitAttId = typeof body.attendanceId === "string" ? body.attendanceId : "";
  if (explicitAttId) {
    att = await c.var.DB
      .prepare("SELECT id, employeeId, date FROM attendance_records WHERE id = ?")
      .bind(explicitAttId)
      .first<{ id: string; employeeId: string; date: string }>();
    if (!att) return c.json({ success: false, error: "Attendance record not found" }, 400);
  } else {
    const workerId = typeof body.workerId === "string" ? body.workerId : "";
    const date = typeof body.date === "string" ? body.date : "";
    if (!workerId || !date) {
      return c.json({ success: false, error: "Provide attendanceId, or workerId + date" }, 400);
    }
    att = await resolveOrCreateAttendance(c, workerId, date);
    if (!att) return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // Validate every entry up-front so a single bad row aborts before any write.
  const validated: Array<{ departmentCode: string; category: string; hours: number; notes: string }> = [];
  for (let i = 0; i < body.entries.length; i++) {
    const v = validateEntry(body.entries[i] as EntryInput);
    if (!v.ok) return c.json({ success: false, error: `entries[${i}]: ${v.error}` }, 400);
    validated.push(v.data);
  }

  const stmts = [
    c.var.DB.prepare("DELETE FROM working_hour_entries WHERE attendanceId = ?").bind(att.id),
    ...validated.map((e) =>
      c.var.DB.prepare(
        `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        genId(),
        att.id,
        att.employeeId,
        att.date,
        e.departmentCode,
        e.category || null,
        e.hours,
        e.notes,
      ),
    ),
  ];
  await c.var.DB.batch(stmts);

  const res = await c.var.DB.prepare(
    "SELECT * FROM working_hour_entries WHERE attendanceId = ? ORDER BY departmentCode, category",
  )
    .bind(att.id)
    .all<EntryRow>();
  const data = (res.results ?? []).map(rowToEntry);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// PUT /:id — partial update of an entry (departmentCode / category / hours / notes)
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "attendance", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  let body: EntryInput;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }

  const existing = await c.var.DB.prepare(
    "SELECT * FROM working_hour_entries WHERE id = ?",
  )
    .bind(id)
    .first<EntryRow>();
  if (!existing) return c.json({ success: false, error: "Entry not found" }, 404);

  // Merge incoming fields onto the existing row, then re-validate the whole.
  const merged: EntryInput = {
    departmentCode: body.departmentCode ?? existing.departmentCode,
    category: body.category ?? existing.category ?? "",
    hours: body.hours ?? existing.hours,
    notes: body.notes ?? existing.notes ?? "",
  };
  const v = validateEntry(merged);
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);

  await c.var.DB.prepare(
    `UPDATE working_hour_entries
       SET departmentCode = ?, category = ?, hours = ?, notes = ?,
           updatedAt = datetime('now')
     WHERE id = ?`,
  )
    .bind(v.data.departmentCode, v.data.category || null, v.data.hours, v.data.notes, id)
    .run();

  const row = await c.var.DB.prepare("SELECT * FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return c.json({ success: true, data: rowToEntry(row!) });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "attendance", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT id FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Entry not found" }, 404);
  await c.var.DB.prepare("DELETE FROM working_hour_entries WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id } });
});

// ---------------------------------------------------------------------------
// Non-production hours APPROVE / REJECT (admin side, owner 2026-06-26).
//
// A worker applies for "X hours in <non-prod dept> on <date>" via the worker
// portal (POST /api/worker/nonprod-requests). The office sees PENDING requests
// on the Working Hours screen and Approves / Rejects them here.
//
//   GET    /nonprod-requests?status=PENDING        list requests for review
//   POST   /nonprod-requests/:id/approve           write the WHE row + mark APPROVED
//   POST   /nonprod-requests/:id/reject            mark REJECTED
//
// On APPROVE we write a normal working_hour_entries row for that worker / date /
// non-prod dept / hours using the SAME write path the Working Hours grid uses
// (resolveOrCreateAttendance → validateEntry → INSERT). Non-prod depts carry no
// category, so the row passes validateEntry and is EXCLUDED from the efficiency
// denominator (which counts only isProduction depts) — efficiency rises with no
// formula change. Idempotent: approving an already-decided request is a no-op.
// ---------------------------------------------------------------------------
type NonprodReqRow = {
  id: string;
  worker_id: string;
  date: string;
  department_code: string;
  hours: number | string;
  note: string | null;
  status: string;
  created_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  entry_id: string | null;
  kind: string | null;
  job_card_id: string | null;
  reject_reason: string | null;
  approved_hours: number | string | null;
};

function reqRowToJson(r: NonprodReqRow & Record<string, unknown>) {
  const pick = (a: unknown, b: unknown) => a ?? b;
  // kind defaults to 'NONPROD' for legacy / pre-column rows — byte-identical.
  const kindRaw = String(pick(r.kind, r.kind) ?? "");
  return {
    id: String(pick(r.id, r.id) ?? ""),
    workerId: String(pick(r.workerId, r.worker_id) ?? ""),
    date: String(pick(r.date, r.date) ?? ""),
    departmentCode: String(pick(r.departmentCode, r.department_code) ?? ""),
    hours: Number(pick(r.hours, r.hours)) || 0,
    note: String(pick(r.note, r.note) ?? ""),
    status: String(pick(r.status, r.status) ?? ""),
    createdAt: String(pick(r.createdAt, r.created_at) ?? ""),
    decidedAt: String(pick(r.decidedAt, r.decided_at) ?? ""),
    decidedBy: String(pick(r.decidedBy, r.decided_by) ?? ""),
    kind: kindRaw === "ADD_PROD" ? "ADD_PROD" : "NONPROD",
    jobCardId: String(pick(r.jobCardId, r.job_card_id) ?? ""),
    rejectReason: String(pick(r.rejectReason, r.reject_reason) ?? ""),
    approvedHours: (() => {
      const v = pick(r.approvedHours, r.approved_hours);
      return v === null || v === undefined || v === "" ? null : Number(v);
    })(),
  };
}

app.get("/nonprod-requests", async (c) => {
  const denied = await requirePermission(c, "attendance", "read");
  if (denied) return denied;
  await ensureNonprodRequests(c.var.DB);
  const status = (c.req.query("status") ?? "").trim().toUpperCase();
  const rows = ["PENDING", "APPROVED", "REJECTED"].includes(status)
    ? await c.var.DB
        .prepare(
          "SELECT * FROM worker_nonprod_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200",
        )
        .bind(status)
        .all<NonprodReqRow>()
    : await c.var.DB
        .prepare(
          "SELECT * FROM worker_nonprod_requests ORDER BY created_at DESC LIMIT 200",
        )
        .all<NonprodReqRow>();
  const reqs = (rows.results ?? []).map((r) =>
    reqRowToJson(r as NonprodReqRow & Record<string, unknown>),
  );
  // Attach worker names so the office sees who applied (cheap one-shot lookup).
  const ids = Array.from(new Set(reqs.map((r) => r.workerId).filter(Boolean)));
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    const wr = await c.var.DB
      .prepare(`SELECT id, name, empNo FROM workers WHERE id IN (${ph})`)
      .bind(...ids)
      .all<{ id: string; name: string; empNo: string }>();
    for (const w of wr.results ?? []) nameById.set(w.id, w.name || w.empNo);
  }
  const data = reqs.map((r) => ({
    ...r,
    workerName: nameById.get(r.workerId) ?? r.workerId,
  }));
  return c.json({ success: true, data, total: data.length });
});

app.post("/nonprod-requests/:id/approve", async (c) => {
  const denied = await requirePermission(c, "attendance", "update");
  if (denied) return denied;
  await ensureNonprodRequests(c.var.DB);
  const id = c.req.param("id");
  const req = await c.var.DB
    .prepare("SELECT * FROM worker_nonprod_requests WHERE id = ?")
    .bind(id)
    .first<NonprodReqRow>();
  if (!req) return c.json({ success: false, error: "Request not found" }, 404);
  const reqJson = reqRowToJson(req as NonprodReqRow & Record<string, unknown>);
  if (reqJson.status !== "PENDING") {
    return c.json(
      { success: false, error: `Request already ${reqJson.status}` },
      409,
    );
  }

  // Owner 2026-07-04: the office may approve LESS than the worker requested
  // (e.g. asked 1h20m, approve 1h). `approvedHours` defaults to the full
  // request and is clamped to (0, requested]. Everything the approval writes —
  // the non-prod WHE row, the production-hours split, and the ADD_PROD
  // efficiency credit — uses `approvedHours`, and we persist it on the row.
  const approveBody = await c.req
    .json<{ approvedHours?: unknown }>()
    .catch(() => ({}) as { approvedHours?: unknown });
  const rawApproved =
    approveBody.approvedHours === undefined || approveBody.approvedHours === null
      ? reqJson.hours
      : Number(approveBody.approvedHours);
  if (!Number.isFinite(rawApproved) || rawApproved <= 0) {
    return c.json({ success: false, error: "Approved hours must be greater than 0." }, 400);
  }
  if (rawApproved > reqJson.hours + 1e-9) {
    return c.json(
      { success: false, error: `Cannot approve more than the ${reqJson.hours}h requested.` },
      400,
    );
  }
  const approvedHours = Math.round(rawApproved * 100) / 100;

  // ----- ADD_PROD (extra production time) -----
  // Owner 2026-06-26: a worker claims extra production time on a PRODUCTION
  // dept (a job that overran its WIP standard). Approving simply marks the
  // request APPROVED — it does NOT write a working_hour_entries row. The
  // approved hours are read at efficiency-compute time and added to the
  // NUMERATOR (credited production minutes); writing a WHE row would instead
  // inflate the DENOMINATOR (production-dept clock-hours) and defeat the point.
  // We still verify the dept really is a production dept (reject, don't fix).
  if (reqJson.kind === "ADD_PROD") {
    const d = await c.var.DB.prepare(
      "SELECT isProduction FROM departments WHERE code = ?",
    )
      .bind(reqJson.departmentCode)
      .first<{ isProduction: number | boolean | null }>();
    if (!d) {
      return c.json({ success: false, error: "Unknown department" }, 400);
    }
    if (!d.isProduction) {
      return c.json(
        {
          success: false,
          error: "Extra production time needs a production department",
        },
        400,
      );
    }
    const decidedBy = getUserId(c);
    await c.var.DB.prepare(
      `UPDATE worker_nonprod_requests
         SET status = 'APPROVED', decided_at = ?, decided_by = ?, approved_hours = ?
       WHERE id = ?`,
    )
      .bind(new Date().toISOString(), decidedBy, approvedHours, id)
      .run();
    // The efficiency NUMERATOR for the office Efficiency Overview is served via
    // the cached /api/job-cards/summary snapshot, which keys freshness on the
    // job_cards table only — an ADD_PROD approval doesn't touch job_cards, so
    // explicitly wipe that snapshot so the next read recomputes with the credit.
    try {
      const { getOrgId } = await import("../lib/tenant");
      const { invalidateSnapshot } = await import("../lib/snapshot");
      await invalidateSnapshot(
        c.var.DB,
        { tableName: "job_cards_summary_snapshot", sourceTables: ["job_cards"] },
        getOrgId(c),
      );
    } catch (e) {
      console.warn("[nonprod-approve] job_cards_summary_snapshot wipe failed:", e);
    }
    return c.json({
      success: true,
      data: { id, status: "APPROVED", kind: "ADD_PROD" },
    });
  }

  // ----- NONPROD (existing behaviour, unchanged) -----
  // Guard (defence in depth — the worker apply path already rejects prod depts):
  // only a NON-production dept may be approved, else the hours would land in the
  // efficiency denominator and defeat the purpose.
  if (PRODUCTION_DEPTS.has(reqJson.departmentCode)) {
    const d = await c.var.DB
      .prepare("SELECT isProduction FROM departments WHERE code = ?")
      .bind(reqJson.departmentCode)
      .first<{ isProduction: number | boolean | null }>();
    if (!d || d.isProduction) {
      return c.json(
        {
          success: false,
          error: "Cannot approve hours for a production department",
        },
        400,
      );
    }
  } else {
    const d = await c.var.DB
      .prepare("SELECT isProduction FROM departments WHERE code = ?")
      .bind(reqJson.departmentCode)
      .first<{ isProduction: number | boolean | null }>();
    if (!d) {
      return c.json({ success: false, error: "Unknown department" }, 400);
    }
    if (d.isProduction) {
      return c.json(
        {
          success: false,
          error: "Cannot approve hours for a production department",
        },
        400,
      );
    }
  }

  // Resolve / create the parent attendance row (SAME helper the Working Hours
  // grid POST uses), then write the working_hour_entries row through the SAME
  // validated shape. Non-prod dept → no category → passes validateEntry.
  const att = await resolveOrCreateAttendance(c, reqJson.workerId, reqJson.date);
  if (!att) return c.json({ success: false, error: "Worker not found" }, 400);

  const v = validateEntry({
    departmentCode: reqJson.departmentCode,
    category: "",
    hours: approvedHours,
    notes: reqJson.note
      ? `Non-production (approved): ${reqJson.note}`
      : "Non-production (approved)",
  });
  if (!v.ok) return c.json({ success: false, error: v.error }, 400);

  const entryId = genId();
  await c.var.DB.prepare(
    `INSERT INTO working_hour_entries (id, attendanceId, workerId, date, departmentCode, category, hours, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entryId,
      att.id,
      att.employeeId,
      att.date,
      v.data.departmentCode,
      v.data.category || null,
      v.data.hours,
      v.data.notes,
    )
    .run();

  // ----- SPLIT the day: move the approved hours OUT of production -----
  // Writing the non-prod row above only ADDS hours to the day. On its own that
  // leaves the worker's PRODUCTION-dept hours (the efficiency denominator)
  // unchanged, so the approval has no effect on efficiency. To make the
  // approval matter we mirror the manual split the Working Hours grid does:
  // DEDUCT the approved hours from this worker's production-dept
  // working_hour_entries on the SAME date, largest entry first, floored at 0.
  //
  // Net effect: the day's TOTAL clocked hours stay constant (pay unaffected) —
  // we added `hours` to a non-prod dept and removed the same `hours` from
  // production depts — but the denominator (production hours) drops, so
  // efficiency rises. If the worker has no production hours that day (or fewer
  // than approved) we deduct only what's available and never go negative; the
  // worst case is the denominator reaching 0 for that day's prod entries.
  try {
    // Which departments count toward the production denominator? Authoritative
    // source = departments.isProduction (the exact flag the efficiency
    // computation uses), not the hardcoded PRODUCTION_DEPTS set.
    const deptRows = await c.var.DB
      .prepare("SELECT code, isProduction FROM departments")
      .bind()
      .all<{ code: string; isProduction: number | boolean | null }>();
    const prodDeptCodes = new Set<string>();
    for (const d of deptRows.results ?? []) {
      if (d.isProduction) prodDeptCodes.add(d.code);
    }

    // This worker's working_hour_entries for the approved date, restricted to
    // production depts and positive hours, largest first.
    const dayRows = await c.var.DB
      .prepare(
        `SELECT id, departmentCode, hours FROM working_hour_entries
          WHERE workerId = ? AND date = ?`,
      )
      .bind(reqJson.workerId, reqJson.date)
      .all<{ id: string; departmentCode: string; hours: number }>();
    const prodEntries = (dayRows.results ?? [])
      .map((r) => ({
        id: r.id,
        departmentCode: r.departmentCode,
        hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
      }))
      .filter((r) => prodDeptCodes.has(r.departmentCode) && r.hours > 0)
      .sort((a, b) => b.hours - a.hours);

    let remaining = approvedHours;
    for (const e of prodEntries) {
      if (remaining <= 0) break;
      const take = Math.min(e.hours, remaining);
      const newHours = e.hours - take; // floored at 0 by construction (take ≤ hours)
      remaining -= take;
      // SAME UPDATE shape the grid edit (PUT /:id) uses — only hours changes.
      await c.var.DB.prepare(
        `UPDATE working_hour_entries
           SET hours = ?, updatedAt = datetime('now')
         WHERE id = ?`,
      )
        .bind(newHours, e.id)
        .run();
    }
  } catch (e) {
    // A failure here must not lose the approval (the non-prod row is already
    // written and the request will be marked APPROVED below). Log and continue;
    // the office can re-split manually via the Working Hours grid if needed.
    console.warn("[nonprod-approve] production-hours split failed:", e);
  }

  const decidedBy = getUserId(c);
  await c.var.DB.prepare(
    `UPDATE worker_nonprod_requests
       SET status = 'APPROVED', decided_at = ?, decided_by = ?, entry_id = ?, approved_hours = ?
     WHERE id = ?`,
  )
    .bind(new Date().toISOString(), decidedBy, entryId, approvedHours, id)
    .run();

  return c.json({
    success: true,
    data: { id, status: "APPROVED", entryId, approvedHours },
  });
});

app.post("/nonprod-requests/:id/reject", async (c) => {
  const denied = await requirePermission(c, "attendance", "update");
  if (denied) return denied;
  await ensureNonprodRequests(c.var.DB);
  const id = c.req.param("id");
  const req = await c.var.DB
    .prepare("SELECT * FROM worker_nonprod_requests WHERE id = ?")
    .bind(id)
    .first<NonprodReqRow>();
  if (!req) return c.json({ success: false, error: "Request not found" }, 404);
  const reqJson = reqRowToJson(req as NonprodReqRow & Record<string, unknown>);
  if (reqJson.status !== "PENDING") {
    return c.json(
      { success: false, error: `Request already ${reqJson.status}` },
      409,
    );
  }
  // Owner 2026-07-04: a rejection MUST carry a reason — the worker sees it on
  // their portal so they know why (and can re-apply correctly). Reject an empty
  // reason rather than silently blanking it.
  const body = await c.req
    .json<{ reason?: unknown }>()
    .catch(() => ({}) as { reason?: unknown });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return c.json(
      { success: false, error: "A reason is required to reject this request." },
      400,
    );
  }
  const decidedBy = getUserId(c);
  await c.var.DB.prepare(
    `UPDATE worker_nonprod_requests
       SET status = 'REJECTED', decided_at = ?, decided_by = ?, reject_reason = ?
     WHERE id = ?`,
  )
    .bind(new Date().toISOString(), decidedBy, reason, id)
    .run();
  return c.json({ success: true, data: { id, status: "REJECTED", rejectReason: reason } });
});

// ---------------------------------------------------------------------------
// POST /nonprod-requests/:id/remove
//
// Owner 2026-06-27: let the office DELETE a *bad APPROVED* time-adjustment
// claim (e.g. a 20h ADD_PROD entered before the minutes fix). This REVERSES
// whatever the approve path did, then marks the request REMOVED so it no
// longer counts. Only an APPROVED request can be removed (reject already
// covers PENDING). Same permission as approve (attendance:update).
//
//   ADD_PROD — approve only flipped the status + wiped the efficiency
//     numerator snapshot; it wrote no working_hour_entries row. So removal
//     just marks the request REMOVED and wipes the SAME snapshot, and the
//     numerator recomputes without the credit.
//
//   NONPROD — approve INSERTED a non-prod working_hour_entries row AND
//     DEDUCTED the same hours from that day's PRODUCTION entries (the split).
//     To reverse, conserving the day's total hours:
//       1. delete the inserted non-prod WHE row (by entry_id; fall back to a
//          worker+date+dept+'(approved)' note match for legacy rows that
//          predate entry_id being stored),
//       2. add the request's hours BACK to the worker's largest production
//          WHE entry for that day (best-effort restore of the split). If the
//          worker has no production entry left, nothing is added back — the
//          day total still nets out because the non-prod row was removed.
// ---------------------------------------------------------------------------
app.post("/nonprod-requests/:id/remove", async (c) => {
  const denied = await requirePermission(c, "attendance", "update");
  if (denied) return denied;
  await ensureNonprodRequests(c.var.DB);
  const id = c.req.param("id");
  const req = await c.var.DB
    .prepare("SELECT * FROM worker_nonprod_requests WHERE id = ?")
    .bind(id)
    .first<NonprodReqRow>();
  if (!req) return c.json({ success: false, error: "Request not found" }, 404);
  const reqJson = reqRowToJson(req as NonprodReqRow & Record<string, unknown>);
  if (reqJson.status !== "APPROVED") {
    return c.json(
      { success: false, error: `Only an APPROVED request can be removed (this one is ${reqJson.status})` },
      409,
    );
  }
  const entryId = String(
    (req as NonprodReqRow & Record<string, unknown>).entryId ?? req.entry_id ?? "",
  );
  const decidedBy = getUserId(c);

  // ----- ADD_PROD: no WHE row was written; just un-credit the numerator. -----
  if (reqJson.kind === "ADD_PROD") {
    await c.var.DB.prepare(
      `UPDATE worker_nonprod_requests
         SET status = 'REMOVED', decided_at = ?, decided_by = ?
       WHERE id = ?`,
    )
      .bind(new Date().toISOString(), decidedBy, id)
      .run();
    // Wipe the same snapshot the approve path invalidated so the office
    // Efficiency Overview recomputes WITHOUT this (now removed) credit.
    try {
      const { getOrgId } = await import("../lib/tenant");
      const { invalidateSnapshot } = await import("../lib/snapshot");
      await invalidateSnapshot(
        c.var.DB,
        { tableName: "job_cards_summary_snapshot", sourceTables: ["job_cards"] },
        getOrgId(c),
      );
    } catch (e) {
      console.warn("[nonprod-remove] job_cards_summary_snapshot wipe failed:", e);
    }
    return c.json({
      success: true,
      data: { id, status: "REMOVED", kind: "ADD_PROD" },
    });
  }

  // ----- NONPROD: delete the inserted non-prod row + restore the split. -----
  try {
    // 1. Delete the non-prod working_hour_entries row the approve path wrote.
    if (entryId) {
      await c.var.DB
        .prepare("DELETE FROM working_hour_entries WHERE id = ?")
        .bind(entryId)
        .run();
    } else {
      // Legacy fallback (entry_id wasn't stored): match by the exact shape the
      // approve path inserted — worker + date + dept + the '(approved)' note.
      await c.var.DB
        .prepare(
          `DELETE FROM working_hour_entries
            WHERE workerId = ? AND date = ? AND departmentCode = ?
              AND notes LIKE 'Non-production (approved)%'`,
        )
        .bind(reqJson.workerId, reqJson.date, reqJson.departmentCode)
        .run();
    }

    // 2. Add the hours back to the worker's largest production WHE entry that
    //    day (best-effort restore of the deduction the approve split made).
    const deptRows = await c.var.DB
      .prepare("SELECT code, isProduction FROM departments")
      .bind()
      .all<{ code: string; isProduction: number | boolean | null }>();
    const prodDeptCodes = new Set<string>();
    for (const d of deptRows.results ?? []) {
      if (d.isProduction) prodDeptCodes.add(d.code);
    }
    const dayRows = await c.var.DB
      .prepare(
        `SELECT id, departmentCode, hours FROM working_hour_entries
          WHERE workerId = ? AND date = ?`,
      )
      .bind(reqJson.workerId, reqJson.date)
      .all<{ id: string; departmentCode: string; hours: number }>();
    const prodEntries = (dayRows.results ?? [])
      .map((r) => ({
        id: r.id,
        departmentCode: r.departmentCode,
        hours: typeof r.hours === "number" ? r.hours : Number(r.hours) || 0,
      }))
      .filter((r) => prodDeptCodes.has(r.departmentCode))
      .sort((a, b) => b.hours - a.hours);
    if (prodEntries.length > 0 && reqJson.hours > 0) {
      const target = prodEntries[0];
      const newHours = target.hours + reqJson.hours;
      await c.var.DB.prepare(
        `UPDATE working_hour_entries
           SET hours = ?, updatedAt = datetime('now')
         WHERE id = ?`,
      )
        .bind(newHours, target.id)
        .run();
    }
  } catch (e) {
    // A failure here must not block marking the request REMOVED — the office
    // can re-balance the day manually via the Working Hours grid if needed.
    console.warn("[nonprod-remove] reversal failed:", e);
  }

  await c.var.DB.prepare(
    `UPDATE worker_nonprod_requests
       SET status = 'REMOVED', decided_at = ?, decided_by = ?
     WHERE id = ?`,
  )
    .bind(new Date().toISOString(), decidedBy, id)
    .run();

  return c.json({ success: true, data: { id, status: "REMOVED" } });
});

export default app;
