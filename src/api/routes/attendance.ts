// ---------------------------------------------------------------------------
// D1-backed attendance route.
//
// Mirrors the old src/api/routes/attendance.ts shape:
//   GET  /api/attendance?date=YYYY-MM-DD  → list records (optionally by date)
//   POST /api/attendance                   → CLOCK_IN / CLOCK_OUT
//
// `deptBreakdown` is stored as JSON in the DB and parsed back into an array
// in the response so the frontend can render per-department minutes.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type AttendanceRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  departmentCode: string;
  departmentName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  workingMinutes: number;
  productionTimeMinutes: number;
  efficiencyPct: number;
  overtimeMinutes: number;
  deptBreakdown: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

type WorkerRow = {
  id: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  workingHoursPerDay: number | null;
};

type DepartmentRow = {
  id: string;
  shortName: string;
};

function parseDeptBreakdown(raw: string): Array<{
  deptCode: string;
  minutes: number;
  productCode: string;
}> {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowToAttendance(r: AttendanceRow) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    departmentCode: r.departmentCode,
    departmentName: r.departmentName,
    date: r.date,
    clockIn: r.clockIn,
    clockOut: r.clockOut,
    status: r.status,
    workingMinutes: r.workingMinutes,
    productionTimeMinutes: r.productionTimeMinutes,
    efficiencyPct: r.efficiencyPct,
    overtimeMinutes: r.overtimeMinutes,
    deptBreakdown: parseDeptBreakdown(r.deptBreakdown),
    notes: r.notes,
  };
}

function genId(): string {
  return `att-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// GET /api/attendance?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const date = c.req.query("date");
  const stmt = date
    ? c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE orgId = ? AND date = ? ORDER BY employeeId",
      ).bind(orgId, date)
    : c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE orgId = ? ORDER BY date DESC, employeeId",
      ).bind(orgId);
  const res = await stmt.all<AttendanceRow>();
  const data = (res.results ?? []).map(rowToAttendance);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/attendance — CLOCK_IN | CLOCK_OUT
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "attendance", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();

    const worker = await c.var.DB.prepare(
      "SELECT id, name, departmentId, departmentCode, workingHoursPerDay FROM workers WHERE id = ?",
    )
      .bind(body.employeeId)
      .first<WorkerRow>();
    if (!worker) {
      return c.json({ success: false, error: "Worker not found" }, 400);
    }

    const date = body.date || new Date().toISOString().split("T")[0];
    const now = new Date();
    const time =
      body.time ||
      `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const existing = await c.var.DB.prepare(
      "SELECT * FROM attendance_records WHERE employeeId = ? AND date = ?",
    )
      .bind(worker.id, date)
      .first<AttendanceRow>();

    if (body.action === "CLOCK_IN") {
      if (existing) {
        // Update the clock-in time on an existing row.
        await c.var.DB.prepare(
          `UPDATE attendance_records
             SET clockIn = ?, status = 'PRESENT',
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`,
        )
          .bind(time, existing.id)
          .run();
        const row = await c.var.DB.prepare(
          "SELECT * FROM attendance_records WHERE id = ?",
        )
          .bind(existing.id)
          .first<AttendanceRow>();
        return c.json({ success: true, data: rowToAttendance(row!) });
      }

      const dept = worker.departmentId
        ? await c.var.DB.prepare(
            "SELECT id, shortName FROM departments WHERE id = ?",
          )
            .bind(worker.departmentId)
            .first<DepartmentRow>()
        : null;

      const id = genId();
      const deptBreakdown = JSON.stringify([
        {
          deptCode: worker.departmentCode ?? "",
          minutes: 0,
          productCode: "",
        },
      ]);
      await c.var.DB.prepare(
        `INSERT INTO attendance_records (
           id, employeeId, employeeName, departmentCode, departmentName,
           date, clockIn, clockOut, status, workingMinutes, productionTimeMinutes,
           efficiencyPct, overtimeMinutes, deptBreakdown, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'PRESENT', 0, 0, 0, 0, ?, '')`,
      )
        .bind(
          id,
          worker.id,
          worker.name,
          worker.departmentCode ?? "",
          dept?.shortName ?? "",
          date,
          time,
          deptBreakdown,
        )
        .run();

      const row = await c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE id = ?",
      )
        .bind(id)
        .first<AttendanceRow>();
      return c.json({ success: true, data: rowToAttendance(row!) }, 201);
    }

    if (body.action === "CLOCK_OUT") {
      if (!existing) {
        return c.json(
          { success: false, error: "No clock-in record found for this date" },
          400,
        );
      }

      const clockIn = existing.clockIn;
      let workingMinutes = 0;
      let productionTimeMinutes = 0;
      let efficiencyPct = 0;
      let overtimeMinutes = 0;
      let deptBreakdown = existing.deptBreakdown;

      if (clockIn) {
        const [inH, inM] = clockIn.split(":").map(Number);
        const [outH, outM] = time.split(":").map(Number);
        const total = outH * 60 + outM - (inH * 60 + inM);
        workingMinutes = Math.max(0, total);
        productionTimeMinutes = Math.max(0, Math.round(total * 0.85));
        const standardMinutes = (worker.workingHoursPerDay ?? 9) * 60;
        efficiencyPct = Math.round((productionTimeMinutes / standardMinutes) * 100);
        overtimeMinutes = Math.max(0, total - standardMinutes);
        deptBreakdown = JSON.stringify([
          {
            deptCode: worker.departmentCode ?? "",
            minutes: productionTimeMinutes,
            productCode: "",
          },
        ]);
      }

      await c.var.DB.prepare(
        `UPDATE attendance_records
           SET clockOut = ?, workingMinutes = ?, productionTimeMinutes = ?,
               efficiencyPct = ?, overtimeMinutes = ?, deptBreakdown = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
        .bind(
          time,
          workingMinutes,
          productionTimeMinutes,
          efficiencyPct,
          overtimeMinutes,
          deptBreakdown,
          existing.id,
        )
        .run();

      const row = await c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE id = ?",
      )
        .bind(existing.id)
        .first<AttendanceRow>();
      return c.json({ success: true, data: rowToAttendance(row!) });
    }

    return c.json(
      { success: false, error: "Invalid action. Use CLOCK_IN or CLOCK_OUT" },
      400,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;
