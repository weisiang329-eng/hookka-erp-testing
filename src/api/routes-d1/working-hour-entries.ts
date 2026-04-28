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

const app = new Hono<Env>();

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
const PRODUCTION_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
]);
const VALID_CATEGORIES = new Set(["SOFA", "BEDFRAME", "ACCESSORY"]);

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
  // (recognition date = MAX completedDate), then we join out to PO/SO/SO line
  // /product for qty/price/category/display fields. ORDER BY DESC so the rows
  // array is already sorted for the frontend table.
  const rowsRes = await c.var.DB
    .prepare(
      `WITH per_po AS (
         SELECT productionOrderId,
                MAX(completedDate) AS unit_completed_at,
                COUNT(*) AS uph_jc_count
           FROM job_cards
          WHERE departmentCode = 'UPHOLSTERY'
            AND status IN ('COMPLETED','TRANSFERRED')
            AND completedDate IS NOT NULL
          GROUP BY productionOrderId
         HAVING MAX(completedDate) >= ?
            AND MAX(completedDate) <= ?
       )
       SELECT po.id                AS poId,
              per_po.unit_completed_at AS completedAt,
              po.productCode       AS productCode,
              po.productName       AS productName,
              po.customerName      AS customerName,
              po.salesOrderNo      AS soNo,
              po.quantity          AS qty,
              p.category           AS category,
              COALESCE(soi.unitPriceSen, p.basePriceSen, p.price1Sen, 0) AS unitPriceSen
         FROM per_po
         JOIN production_orders po ON po.id = per_po.productionOrderId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN products p ON p.id = po.productId
        WHERE p.category IN ('SOFA','BEDFRAME','ACCESSORY')
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

  for (const r of rowsRes.results ?? []) {
    if (r.category !== "SOFA" && r.category !== "BEDFRAME" && r.category !== "ACCESSORY") continue;
    const unitPriceSen = Math.round(typeof r.unitPriceSen === "number" ? r.unitPriceSen : Number(r.unitPriceSen) || 0);
    const qty = Math.max(1, Math.round(typeof r.qty === "number" ? r.qty : Number(r.qty) || 1));
    const totalPriceSen = unitPriceSen * qty;
    totals[r.category] += totalPriceSen;
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

  const data = {
    SOFA: totals.SOFA,
    BEDFRAME: totals.BEDFRAME,
    ACCESSORY: totals.ACCESSORY,
    totalSen: totals.SOFA + totals.BEDFRAME + totals.ACCESSORY,
    rows,
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

  // One query per (worker, dept) bucket — totals are derived in JS by
  // summing across each worker's bucket rows. distinct(date) per worker
  // gives the daysWithEntries count without a second round trip.
  const rowsRes = await c.var.DB
    .prepare(
      `SELECT workerId,
              departmentCode,
              SUM(hours) AS hours,
              COUNT(DISTINCT date) AS dayCount
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
      `SELECT workerId, COUNT(DISTINCT date) AS dayCount
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
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /daily-breakdown?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Per-day rollups for the Labor Cost vs Revenue tab's "Daily Breakdown" table.
// Returns three date-keyed maps:
//   - orderValueByDate:       sum of sales_orders.totalSen by companySODate
//   - productionValueByDate:  sum of production-revenue per PO (price × qty)
//                             keyed on the LAST UPHOLSTERY job_card's
//                             completedDate — same dedup logic as the
//                             /production-revenue endpoint above
//   - unitsCompletedByDate:   COUNT of UPHOLSTERY job_cards with status
//                             COMPLETED|TRANSFERRED whose completedDate is
//                             in range
//
// Labor cost is intentionally NOT computed here: it depends on per-worker
// basic salary + OT multiplier which are easier to keep in the frontend
// (it already has them via the workers prop) and the per-worker pro-rata
// OT split is already implemented there.
//
// Output values are in sen (raw integer, /100 in UI).
// ---------------------------------------------------------------------------
app.get("/daily-breakdown", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // 1. Order value — sum sales_orders.totalSen grouped by companySODate.
  //    Use companySODate (the date the SO was opened on the company side)
  //    so the chart matches the Sales reports view. Skip rows with empty
  //    companySODate (they get bucketed under "" and filtered out).
  const orderValueRes = await c.var.DB
    .prepare(
      `SELECT companySODate AS d, SUM(totalSen) AS v
         FROM sales_orders
        WHERE companySODate IS NOT NULL
          AND companySODate != ''
          AND companySODate >= ?
          AND companySODate <= ?
        GROUP BY companySODate`,
    )
    .bind(from, to)
    .all<{ d: string; v: number | string | null }>();

  // 2. Production value — same per-PO recognition as /production-revenue.
  //    GROUP BY productionOrderId, recognition date = MAX(completedDate),
  //    revenue = unitPrice × po.quantity. Then aggregate again by date.
  const prodValueRes = await c.var.DB
    .prepare(
      `WITH per_po AS (
         SELECT productionOrderId,
                MAX(completedDate) AS unit_completed_at
           FROM job_cards
          WHERE departmentCode = 'UPHOLSTERY'
            AND status IN ('COMPLETED','TRANSFERRED')
            AND completedDate IS NOT NULL
          GROUP BY productionOrderId
         HAVING MAX(completedDate) >= ?
            AND MAX(completedDate) <= ?
       )
       SELECT substr(per_po.unit_completed_at, 1, 10) AS d,
              SUM(COALESCE(soi.unitPriceSen, p.basePriceSen, p.price1Sen, 0)
                  * MAX(1, COALESCE(po.quantity, 1))) AS v
         FROM per_po
         JOIN production_orders po ON po.id = per_po.productionOrderId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN products p ON p.id = po.productId
        WHERE p.category IN ('SOFA','BEDFRAME','ACCESSORY')
        GROUP BY substr(per_po.unit_completed_at, 1, 10)`,
    )
    .bind(from, to)
    .all<{ d: string; v: number | string | null }>();

  // 3. Units completed — count UPHOLSTERY job_cards completed in range.
  //    Per spec, this is "count of UPHOLSTERY job-cards completed on
  //    that day" — NOT a per-PO dedup, just a raw count of the cards.
  const unitsRes = await c.var.DB
    .prepare(
      `SELECT completedDate AS d, COUNT(*) AS n
         FROM job_cards
        WHERE departmentCode = 'UPHOLSTERY'
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL
          AND completedDate >= ?
          AND completedDate <= ?
        GROUP BY completedDate`,
    )
    .bind(from, to)
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
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT id FROM working_hour_entries WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Entry not found" }, 404);
  await c.var.DB.prepare("DELETE FROM working_hour_entries WHERE id = ?").bind(id).run();
  return c.json({ success: true, data: { id } });
});

export default app;
