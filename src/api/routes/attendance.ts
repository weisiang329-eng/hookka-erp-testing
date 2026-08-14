import { otMinutesAtLeastMinimum } from "../../lib/attendance-rules";
// ---------------------------------------------------------------------------
// D1-backed attendance route.
//
// Mirrors the old src/api/routes/attendance.ts shape:
//   GET  /api/attendance?date=YYYY-MM-DD             → list records for one day
//   GET  /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD → list records in a range
//   GET  /api/attendance                             → list all records
//   POST /api/attendance                             → CLOCK_IN / CLOCK_OUT
//
// `deptBreakdown` is stored as JSON in the DB and parsed back into an array
// in the response so the frontend can render per-department minutes.
//
// ── production_time_minutes / efficiency_pct / dept_breakdown are NOT measured ──
// BUG-2026-08-13-103 (C15). Until this fix the CLOCK_OUT branch below wrote
//
//     productionTimeMinutes = round(workingMinutes × 0.85)
//     efficiencyPct         = productionTimeMinutes ÷ standardMinutes × 100
//     deptBreakdown         = one entry carrying that same figure again, under
//                             the worker's home dept and an EMPTY productCode
//
// i.e. a FIXED RATIO of the clock time, published under three captions that all
// read as measured production. Measured on prod for August 2026:
// 180,928 / 212,850 = 0.85005 — the constant showing through. There has never
// been a writer that measured production time here, so EVERY value this column
// has ever held is `clocked × 0.85`; there is nothing to preserve.
//
// The punch now records only what a punch can observe — clock in, clock out,
// the minutes between them, and the overtime rule applied to those minutes —
// and leaves the three derived columns unwritten. `rowToAttendance` publishes
// them as null / [] so an unknown is never mistaken for a measurement.
// The real labour-efficiency metric lives on /api/department-performance
// (earned standard minutes ÷ clocked minutes) and is untouched by this file.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { runSelfApply } from "../lib/self-apply";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Runtime self-apply — make the two unmeasured metric columns NULLABLE.
//
// 0018_attendance.sql declared them `INTEGER NOT NULL DEFAULT 0`, so "not
// measured" could not be expressed: the only writable values were a number.
// A stored 0 is a claim ("zero production time"), which is the same C15 defect
// one step quieter — so the columns are widened to accept NULL and their
// DEFAULT is dropped, letting an omitted column mean "unknown".
//
// Both statements are idempotent: DROP NOT NULL / DROP DEFAULT on a column
// that already permits NULL / has no default is a no-op in Postgres.
//
// Deliberately NOT awaited as a hard precondition — a punch must never fail
// because a DDL round tripped. `metricsNullable()` reports whether NULL is
// writable, and the write paths below fall back to leaving the columns ALONE
// (never to writing a number) when it is not.
// ---------------------------------------------------------------------------
const NULLABLE_METRIC_DDL = [
  `ALTER TABLE attendance_records ALTER COLUMN production_time_minutes DROP NOT NULL`,
  `ALTER TABLE attendance_records ALTER COLUMN production_time_minutes DROP DEFAULT`,
  `ALTER TABLE attendance_records ALTER COLUMN efficiency_pct DROP NOT NULL`,
  `ALTER TABLE attendance_records ALTER COLUMN efficiency_pct DROP DEFAULT`,
];

let _pendingNullableMetrics: Promise<void> | null = null;
export function ensureAttendanceMetricsNullable(db: D1Database): Promise<void> {
  if (_pendingNullableMetrics) return _pendingNullableMetrics;
  _pendingNullableMetrics = (async () => {
    await runSelfApply(db, "attendance", NULLABLE_METRIC_DDL);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — dropping the memo lets
    // the next punch retry (same contract as every other self-apply here).
    _pendingNullableMetrics = null;
    throw err;
  });
  return _pendingNullableMetrics;
}

/**
 * True when `production_time_minutes` / `efficiency_pct` can be written NULL.
 * On failure returns false — the caller then OMITS the columns from its write.
 * It must never respond by computing a value: that is the bug this fixes.
 */
export async function metricsNullable(db: D1Database): Promise<boolean> {
  try {
    await ensureAttendanceMetricsNullable(db);
    return true;
  } catch (e) {
    console.warn("[attendance] metric columns still NOT NULL; leaving them unwritten:", e);
    return false;
  }
}

type AttendanceRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  departmentCode: string;
  departmentName: string;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  clockInLat: number | null;
  clockInLng: number | null;
  clockOutLat: number | null;
  clockOutLng: number | null;
  clockInPhoto: string | null;
  clockOutPhoto: string | null;
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

// The per-department split the response shape still declares. `parseDeptBreakdown`
// — which read `dept_breakdown` back out of the row — was DELETED with
// BUG-2026-08-13-103 rather than left unused: the only thing that column has
// ever held is one entry carrying the fabricated production minutes under an
// empty productCode, so a parser for it is a loaded gun. Restoring per-department
// minutes means a writer that measures them first.
type DeptBreakdownEntry = {
  deptCode: string;
  minutes: number;
  productCode: string;
};

function rowToAttendance(r: AttendanceRow) {
  // Runtime-added columns (geo + punch selfie) were created through the
  // d1-compat adapter, whose identifier rewrite only knows the STATIC rename
  // map — unknown camelCase identifiers pass through unquoted and Postgres
  // folds them to all-lowercase ("clockinlat"). Writes target the same folded
  // names (consistent), but a SELECT * returns the folded key, so reading
  // r.clockInLat alone is forever null. Read BOTH keys.
  const rr = r as unknown as Record<string, unknown>;
  const dual = <T>(camel: T | null | undefined, folded: string): T | null =>
    (camel ?? (rr[folded] as T | null | undefined) ?? null);
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employeeName,
    departmentCode: r.departmentCode,
    departmentName: r.departmentName,
    date: r.date,
    clockIn: r.clockIn,
    clockOut: r.clockOut,
    // Soft-geofence punch coordinates (null when the phone gave no GPS). The
    // Attendance view flags out-of-fence punches from these.
    clockInLat: dual(r.clockInLat, "clockinlat"),
    clockInLng: dual(r.clockInLng, "clockinlng"),
    clockOutLat: dual(r.clockOutLat, "clockoutlat"),
    clockOutLng: dual(r.clockOutLng, "clockoutlng"),
    // Punch selfies: the list returns only a HAS-flag (the base64 image is heavy,
    // fetched on demand via GET /:id/photo when the operator clicks to view).
    //
    // THREE key spellings, in order (BUG-2026-08-13-113). The list query no
    // longer SELECTs the blob at all — it asks Postgres for
    // `(clockInPhoto IS NOT NULL) AS hasclockinphoto` — so the flag arrives
    // pre-computed under that alias. The two `dual()` reads behind it are what
    // the POST responses and the fallback `SELECT *` path still return, and
    // they must keep working: a `??` chain, not `||`, because `false` is a
    // legitimate answer from the aliased form and would be swallowed by `||`.
    hasClockInPhoto:
      (rr.hasclockinphoto as boolean | undefined) ??
      !!dual(r.clockInPhoto, "clockinphoto"),
    hasClockOutPhoto:
      (rr.hasclockoutphoto as boolean | undefined) ??
      !!dual(r.clockOutPhoto, "clockoutphoto"),
    status: r.status,
    workingMinutes: r.workingMinutes,
    // ── UNMEASURED — always null. See the file header (BUG-2026-08-13-103). ──
    // These are not read from the row on purpose. Every value the column has
    // ever held was `workingMinutes × 0.85` (a constant, not an observation),
    // so publishing the stored number would republish the fabrication for the
    // ~2,780 historic rows that still carry it. There is no measured value to
    // fall back to, so the honest answer is "unknown": null, rendered "—".
    //
    // Restoring a number here requires a WRITER that measures production time
    // (a scan-in/scan-out per department, or job-card actual durations keyed to
    // the day) — not a ratio of the clock time.
    productionTimeMinutes: null,
    efficiencyPct: null,
    // Same story: the split was one entry carrying that same fabricated number
    // under an EMPTY productCode. An empty array says "no per-department split
    // was recorded", which is true; the stored JSON says something false.
    deptBreakdown: [] as DeptBreakdownEntry[],
    overtimeMinutes: r.overtimeMinutes,
    notes: r.notes,
  };
}

function genId(): string {
  return `att-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// GET /api/attendance?date=YYYY-MM-DD            → single day
// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD → date range
// GET /api/attendance                            → all records
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const date = c.req.query("date");
  const from = c.req.query("from");
  const to = c.req.query("to");
  // Mobile employee-detail card (dc12) needs per-employee attendance for the
  // current month — without this filter the phone would pull every worker's
  // month, then drop 49/50ths client-side. Composes with date/from-to filters.
  const employeeId = c.req.query("employeeId");
  const clauses: string[] = ["orgId = ?"];
  const binds: (string | number)[] = [orgId];
  if (from && to) {
    clauses.push("date >= ?", "date <= ?");
    binds.push(from, to);
  } else if (date) {
    clauses.push("date = ?");
    binds.push(date);
  }
  if (employeeId) {
    clauses.push("employeeId = ?");
    binds.push(employeeId);
  }
  const orderBy = date && !employeeId ? "employeeId" : "date DESC, employeeId";
  // ---------------------------------------------------------------------
  // BUG-2026-08-13-113 — do NOT `SELECT *` here.
  //
  // A punch selfie is REQUIRED to clock in or out (worker/index.tsx:669) and
  // is stored INLINE on the row as a base64 JPEG data URL, capped at 600 KB
  // (worker.ts:stampPunchPhoto). `SELECT *` therefore drags two image blobs
  // per worker-day out of Postgres, across Hyperdrive, into the isolate — and
  // then `rowToAttendance` throws them away and returns a boolean. The
  // response is ~460 bytes/row; the READ behind it is orders of magnitude
  // larger, which is why this endpoint costs ~1.2 ms per row for a payload
  // that size (prod: 2,818 rows → 1.28 MB but 1.7–6.3 s).
  //
  // The Working Hours tab — the DEFAULT tab of /employees — asks for a whole
  // month, so every visit used to pull a month of selfies for every worker.
  //
  // The projection is explicit and the aliases carry the has-flags. Two things
  // make an explicit projection safe here even though the comment on
  // `/:id/photo` warns against one:
  //   * every STATIC column below is in column-rename-map.json, so
  //     supabase-compat rewrites it to the right snake_case name, and the
  //     driver's `transform.column.from` maps it back (db-pg.ts:57).
  //   * the RUNTIME-added geo/photo columns are not in the map, so they pass
  //     through bare and Postgres folds them to all-lowercase — which is
  //     exactly the name they were CREATED with through this same path. The
  //     `dual()` reads in rowToAttendance already expect the folded key.
  // What an explicit projection cannot survive is a database where the runtime
  // columns do not exist yet (nobody has punched): naming a missing column is
  // a hard error where `SELECT *` simply omits it. Hence the fallback below —
  // worst case is exactly today's behaviour, one wasted query later.
  // ---------------------------------------------------------------------
  const NARROW_COLS = [
    "id",
    "employeeId",
    "employeeName",
    "departmentCode",
    "departmentName",
    "date",
    "clockIn",
    "clockOut",
    "status",
    "workingMinutes",
    "productionTimeMinutes",
    "efficiencyPct",
    "overtimeMinutes",
    "deptBreakdown",
    "notes",
    "clockInLat",
    "clockInLng",
    "clockOutLat",
    "clockOutLng",
    "(clockInPhoto IS NOT NULL) AS hasclockinphoto",
    "(clockOutPhoto IS NOT NULL) AS hasclockoutphoto",
  ].join(", ");
  const where = `WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy}`;
  let results: AttendanceRow[];
  try {
    const res = await c.var.DB.prepare(
      `SELECT ${NARROW_COLS} FROM attendance_records ${where}`,
    )
      .bind(...binds)
      .all<AttendanceRow>();
    results = res.results ?? [];
  } catch (e) {
    // Fall back ONLY for "that column does not exist" (Postgres 42703) — a cold
    // database where nobody has punched yet, so the runtime-added geo/photo
    // columns have not been self-applied. A bare `catch {}` here would also
    // swallow a transient pooler failure and answer it with a second heavy
    // query instead of the 503 isTransientDbError() exists to produce, so
    // anything else is rethrown unchanged.
    const code = (e as { code?: string } | null)?.code ?? "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code !== "42703" && !/column .* does not exist/i.test(msg)) throw e;
    const res = await c.var.DB.prepare(
      `SELECT * FROM attendance_records ${where}`,
    )
      .bind(...binds)
      .all<AttendanceRow>();
    results = res.results ?? [];
  }
  const data = results.map(rowToAttendance);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// DELETE /api/attendance/:id — remove one attendance record (admin cleanup,
// e.g. test-account punches before go-live). Org-scoped; RBAC-gated.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "attendance", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const res = await c.var.DB.prepare(
    "DELETE FROM attendance_records WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return c.json({ success: false, error: "Attendance record not found" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/attendance/:id/photo?which=in|out → the punch selfie as a real JPEG
// response (Content-Type image/jpeg), so the Attendance view can render it with
// a plain <img src> (browser lazy-loads + caches; the list itself stays lean).
// Fetched on demand. Scoped by org — no cross-tenant read.
// ---------------------------------------------------------------------------
app.get("/:id/photo", async (c) => {
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const which = c.req.query("which") === "out" ? "out" : "in";
  // SELECT * (not an explicit camelCase projection): the d1-compat adapter
  // translates snake_case columns back to camelCase on a `SELECT *` row (same
  // path the geo columns use), and a row missing the column simply yields
  // undefined instead of a 500 — so this also survives before the first punch
  // has self-applied the photo columns.
  const row = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<{ clockInPhoto?: string | null; clockOutPhoto?: string | null }>();
  // Dual-key read — the runtime-added photo columns are folded-lowercase on
  // prod (see rowToAttendance), so check both key spellings.
  const rowAny = (row ?? {}) as Record<string, unknown>;
  const dataUrl =
    which === "out"
      ? ((row?.clockOutPhoto ?? rowAny.clockoutphoto) as string | null | undefined)
      : ((row?.clockInPhoto ?? rowAny.clockinphoto) as string | null | undefined);
  if (!dataUrl) return c.json({ success: false, error: "No photo" }, 404);
  // Stored as a data URL (data:image/jpeg;base64,...). Decode to raw bytes so an
  // <img> can render it directly and the browser can cache it.
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  let buf: ArrayBuffer;
  try {
    const bin = atob(b64);
    buf = new ArrayBuffer(bin.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return c.json({ success: false, error: "Bad photo data" }, 500);
  }
  return new Response(buf, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
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
      // productionTimeMinutes / efficiencyPct are OMITTED from the column list:
      // at clock-in nothing about production has been observed yet, and an
      // explicit 0 would claim "no production time" (C15's first corollary).
      // With the self-apply above they land NULL; without it they land on the
      // legacy DEFAULT 0 — either way this route never publishes them.
      // deptBreakdown starts as an empty array rather than one zero-minute
      // entry for the worker's home department, for the same reason.
      await c.var.DB.prepare(
        `INSERT INTO attendance_records (
           id, employeeId, employeeName, departmentCode, departmentName,
           date, clockIn, clockOut, status, workingMinutes,
           overtimeMinutes, deptBreakdown, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'PRESENT', 0, 0, '[]', '')`,
      )
        .bind(
          id,
          worker.id,
          worker.name,
          worker.departmentCode ?? "",
          dept?.shortName ?? "",
          date,
          time,
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
      let overtimeMinutes = 0;

      if (clockIn) {
        const [inH, inM] = clockIn.split(":").map(Number);
        const [outH, outM] = time.split(":").map(Number);
        const total = outH * 60 + outM - (inH * 60 + inM);
        // The two things a punch actually measures: how long the worker was on
        // the clock, and how much of that is overtime under the shift rules.
        workingMinutes = Math.max(0, total);
        const standardMinutes = (worker.workingHoursPerDay ?? 9) * 60;
        // Same 30-minute OT minimum the payroll engine and the punch use.
        overtimeMinutes = otMinutesAtLeastMinimum(total - standardMinutes);
      }

      // productionTimeMinutes / efficiencyPct / deptBreakdown are CLEARED, not
      // computed (BUG-2026-08-13-103). Clearing rather than leaving them lets a
      // re-punch scrub the fabricated value a pre-fix clock-out already wrote.
      // If the columns are still NOT NULL (self-apply could not run) they are
      // dropped from the SET list entirely — the fallback is silence, never a
      // number. `metricsNullable` is a fixed internal literal, not user input.
      const canNull = await metricsNullable(c.var.DB);
      const clearMetrics = canNull
        ? "productionTimeMinutes = NULL, efficiencyPct = NULL, deptBreakdown = '[]',"
        : "deptBreakdown = '[]',";

      await c.var.DB.prepare(
        `UPDATE attendance_records
           SET clockOut = ?, workingMinutes = ?, ${clearMetrics}
               overtimeMinutes = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
        .bind(
          time,
          workingMinutes,
          overtimeMinutes,
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
