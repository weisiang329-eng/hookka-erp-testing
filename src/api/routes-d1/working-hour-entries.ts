// ---------------------------------------------------------------------------
// D1-backed working_hour_entries route.
//
//   GET    /api/working-hour-entries?attendanceId=...
//   GET    /api/working-hour-entries?date=YYYY-MM-DD
//   GET    /api/working-hour-entries?workerId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET    /api/working-hour-entries/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
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
// "Production Revenue" — revenue is recognized the day each PHYSICAL UNIT
// completes production, NOT per-job_card. A single product unit (e.g. one
// CODY BEDFRAME) consists of multiple PIECES (HB, Divan, Cushion, …) each
// tracked as its own job_card. Counting per-job_card means the unit's
// catalog price gets scored 2-4× as each piece completes.
//
// Per spec: revenue recognizes ONCE per (productionOrderId, unitNo) — on the
// date the LAST piece of that unit finishes production. Source of truth is
// the fg_units table, which has one row per (poId, unitNo, pieceNo) and
// tracks `upholsteredAt` / `packedAt` on each piece.
//
// Completion timestamp uses COALESCE(upholsteredAt, packedAt). Operators
// frequently jump straight from prior stages to PACKED, skipping a separate
// UPHOLSTERED stamp — packedAt then carries the same semantic ("the day
// the last piece of this unit completed production") because you cannot
// pack a unit until upholstery is physically done. Filtering on
// upholsteredAt alone returned RM 0 against real production data even
// when 31 units were genuinely PACKED.
//
// Stage 1: aggregate fg_units → unit-level "completed" set (every piece for
//          (poId, unitNo) has reached UPHOLSTERED+ status). Recognition date
//          = max(COALESCE(upholsteredAt, packedAt)) across the unit's pieces.
// Stage 2: join unit → production_order → sales_order_item / product for
//          price + category bucketing.
//
// Price COALESCE chain: sales_order_items.unitPriceSen → products.basePriceSen
// → products.price1Sen → 0. SO line wins because it's the contract price the
// customer actually pays (catalog price misses promo/contract pricing).
//
// Edge cases:
//   - Pieces with both upholsteredAt AND packedAt NULL are skipped (status
//     alone isn't enough proof that production actually completed on a
//     known date).
//   - totalPieces NULL → treated as 1 via MAX(COALESCE(totalPieces, 1)).
//   - Window filter is on max(COALESCE(upholsteredAt, packedAt)) so a unit
//     straddling the boundary gets attributed to the date of its FINAL piece.
//
// Response also includes a `rows` array — one entry per recognized unit —
// for the "Revenue Raw Data" audit table on the Labor Cost tab.
// ---------------------------------------------------------------------------
app.get("/production-revenue", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ success: false, error: "Provide from + to (YYYY-MM-DD)" }, 400);
  }

  // Single SQL: per_unit CTE finds fully-upholstered units in the window,
  // then we join out to PO/SO/product for price + category + display fields.
  // ORDER BY unit_completed_at DESC so the rows array is already sorted for
  // the frontend table.
  const rowsRes = await c.var.DB
    .prepare(
      `WITH per_unit AS (
         SELECT poId,
                unitNo,
                COUNT(*) AS pieces_done,
                MAX(COALESCE(totalPieces, 1)) AS expected_pieces,
                MAX(COALESCE(upholsteredAt, packedAt)) AS unit_completed_at
           FROM fg_units
          WHERE poId IS NOT NULL
            AND unitNo IS NOT NULL
            AND status IN ('UPHOLSTERED','PACKED','LOADED','DELIVERED')
            AND COALESCE(upholsteredAt, packedAt) IS NOT NULL
          GROUP BY poId, unitNo
         HAVING COUNT(*) >= MAX(COALESCE(totalPieces, 1))
            AND MAX(COALESCE(upholsteredAt, packedAt)) >= ?
            AND MAX(COALESCE(upholsteredAt, packedAt)) <= ?
       )
       SELECT u.poId               AS poId,
              u.unitNo             AS unitNo,
              u.unit_completed_at  AS completedAt,
              po.productCode       AS productCode,
              po.productName       AS productName,
              po.customerName      AS customerName,
              po.salesOrderNo      AS soNo,
              p.category           AS category,
              COALESCE(soi.unitPriceSen, p.basePriceSen, p.price1Sen, 0) AS unitPriceSen
         FROM per_unit u
         JOIN production_orders po ON po.id = u.poId
         LEFT JOIN sales_order_items soi
                ON soi.salesOrderId = po.salesOrderId
               AND soi.lineNo = po.lineNo
         LEFT JOIN products p ON p.id = po.productId
        WHERE p.category IN ('SOFA','BEDFRAME','ACCESSORY')
        ORDER BY u.unit_completed_at DESC`,
    )
    .bind(from, to)
    .all<{
      poId: string;
      unitNo: number;
      completedAt: string;
      productCode: string | null;
      productName: string | null;
      customerName: string | null;
      soNo: string | null;
      category: "SOFA" | "BEDFRAME" | "ACCESSORY";
      unitPriceSen: number | string | null;
    }>();

  const totals: Record<"SOFA" | "BEDFRAME" | "ACCESSORY", number> = {
    SOFA: 0,
    BEDFRAME: 0,
    ACCESSORY: 0,
  };
  // qty is always 1 — one fg_units row group == one physical unit.
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
    const priceSen = Math.round(typeof r.unitPriceSen === "number" ? r.unitPriceSen : Number(r.unitPriceSen) || 0);
    totals[r.category] += priceSen;
    // completedAt may include time-of-day; the table only needs the date.
    const date = (r.completedAt ?? "").slice(0, 10);
    rows.push({
      date,
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      category: r.category,
      qty: 1,
      unitPriceSen: priceSen,
      totalPriceSen: priceSen,
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
