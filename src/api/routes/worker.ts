// ============================================================
// Worker portal — per-worker scoped endpoints under /api/worker/*.
//
// Replaces src/api/routes-mock/worker.ts (mock-data only, never reachable in
// production) with a real D1 / Postgres-backed surface for the /worker mobile
// portal.  Every endpoint is gated by X-Worker-Token via resolveWorkerToken
// (see worker-auth.ts) — a worker can only ever read/write their own data.
//
// Endpoints:
//   GET    /today        clock + JC counts + earnings estimate
//   POST   /clock        clock in / out
//   GET    /history      attendance + completed JC share calc
//   GET    /payslips     read-only SELECT from existing payslips table
//                        (admin-side payroll run already computes them)
//   GET    /leaves       balance + history
//   POST   /leaves       file PENDING leave
//   GET    /issues       my reported shop-floor issues
//   POST   /issues       file new issue
//   PATCH  /profile      update phone
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { resolveWorkerToken } from "./worker-auth";

const app = new Hono<Env>();

// Piece-rate per department (in sen).  MVP flat-rate — replace with per-op
// rates from a config table later.  Mirrors the mock so /today's earnings
// estimate stays consistent with the prior behaviour.
export const PIECE_RATE_SEN: Record<string, number> = {
  FAB_CUT: 200,
  FAB_SEW: 300,
  FOAM: 250,
  WOOD_CUT: 400,
  FRAMING: 500,
  WEBBING: 300,
  UPHOLSTERY: 800,
  PACKING: 150,
};

// ============================================================
// Default-protect middleware.
//
// Every /api/worker/* request must carry a valid X-Worker-Token.  Resolved
// worker is stashed on the context so handlers can read it via c.get(...)
// without a second DB round-trip.
// ============================================================
type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  // Multi-department JSON array (e.g. '["FAB_CUT","FAB_SEW"]'). Added
  // 2026-05-10 alongside the Operator Leader role; reads fall back to
  // departmentCode when null/empty/unparseable.
  departmentCodes: string | null;
  position: string | null;
  phone: string | null;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
};

// Parse the workers.departmentCodes JSON array safely. Falls back to the
// single primary departmentCode when the JSON is missing/invalid/empty.
function parseWorkerDepartmentCodes(
  raw: string | null,
  fallback: string | null,
): string[] {
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const cleaned = arr.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        );
        if (cleaned.length > 0) return cleaned;
      }
    } catch {
      /* fall through */
    }
  }
  return fallback ? [fallback] : [];
}

// Per-request resolver — every handler calls this once; the token + worker
// row come from the DB on every hit, but `workers` reads are sub-ms via
// Hyperdrive so the simplification beats stashing on c.var (which is
// strictly typed and would require widening Env.Variables).
async function getWorker(
  c: Context<Env>,
): Promise<
  | { ok: true; workerId: string; worker: WorkerRow }
  | { ok: false; response: Response }
> {
  const token = c.req.header("x-worker-token");
  const workerId = await resolveWorkerToken(c.var.DB, token);
  if (!workerId) {
    return {
      ok: false,
      response: c.json({ success: false, error: "Not authenticated" }, 401),
    };
  }
  const w = await c.var.DB.prepare(
    "SELECT id, empNo, name, departmentId, departmentCode, departmentCodes, position, phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth FROM workers WHERE id = ?",
  )
    .bind(workerId)
    .first<WorkerRow>();
  if (!w) {
    return {
      ok: false,
      response: c.json({ success: false, error: "Worker not found" }, 404),
    };
  }
  return { ok: true, workerId, worker: w };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// ----- types for joined queries -----
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
};

type JobCardRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  status: string;
  pic1Id: string | null;
  pic2Id: string | null;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  wipKey: string | null;
  wipCode: string | null;
  wipLabel: string | null;
  wipQty: number | null;
};

type PiecePicRow = {
  jobCardId: string;
  pieceNo: number;
  pic1Id: string | null;
  pic2Id: string | null;
};

type ProductionOrderRow = {
  id: string;
  poNo: string;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeLabel: string | null;
};

// ============================================================
// GET /api/worker/today
// ============================================================
app.get("/today", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId, worker } = auth;
  const today = todayYmd();

  // Today's attendance row, if any.
  const attendance = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE employeeId = ? AND date = ?",
  )
    .bind(workerId, today)
    .first<AttendanceRow>();

  // Pull every JC the worker is on.  Two paths to "mine":
  //   1. JC-level pic1Id / pic2Id (legacy A-flow)
  //   2. piecePics row pointing at this worker (B-flow — per-piece)
  // Then for each JC we recompute using the same logic as the mock.
  const myJcsViaLegacy = await c.var.DB.prepare(
    "SELECT * FROM job_cards WHERE pic1Id = ? OR pic2Id = ?",
  )
    .bind(workerId, workerId)
    .all<JobCardRow>();

  const myPicsRes = await c.var.DB.prepare(
    "SELECT * FROM piece_pics WHERE pic1Id = ? OR pic2Id = ?",
  )
    .bind(workerId, workerId)
    .all<PiecePicRow>();
  const myPics = myPicsRes.results ?? [];

  // Resolve any JCs reachable only through piece_pics (B-flow with no
  // legacy pic on the JC itself).
  const legacyJcIds = new Set((myJcsViaLegacy.results ?? []).map((j) => j.id));
  const extraJcIds = Array.from(
    new Set(myPics.map((p) => p.jobCardId).filter((id) => !legacyJcIds.has(id))),
  );
  let extraJcs: JobCardRow[] = [];
  if (extraJcIds.length > 0) {
    const placeholders = extraJcIds.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT * FROM job_cards WHERE id IN (${placeholders})`,
    )
      .bind(...extraJcIds)
      .all<JobCardRow>();
    extraJcs = r.results ?? [];
  }
  const allJcs = [...(myJcsViaLegacy.results ?? []), ...extraJcs];

  // Group piece_pics by jobCardId for the per-piece walk below.
  const picsByJc = new Map<string, PiecePicRow[]>();
  for (const p of myPics) {
    const arr = picsByJc.get(p.jobCardId) ?? [];
    arr.push(p);
    picsByJc.set(p.jobCardId, arr);
  }
  // Also fetch ALL piece_pics rows for these JCs so we can tell whether a
  // piece is "shared" with another worker (this drives the share count).
  let allPicsForMyJcs: PiecePicRow[] = [];
  if (allJcs.length > 0) {
    const ids = allJcs.map((j) => j.id);
    const placeholders = ids.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders})`,
    )
      .bind(...ids)
      .all<PiecePicRow>();
    allPicsForMyJcs = r.results ?? [];
  }
  const allPicsByJc = new Map<string, PiecePicRow[]>();
  for (const p of allPicsForMyJcs) {
    const arr = allPicsByJc.get(p.jobCardId) ?? [];
    arr.push(p);
    allPicsByJc.set(p.jobCardId, arr);
  }

  let pending = 0;
  let inProgress = 0;
  let doneToday = 0;
  const doneByDept: Record<string, number> = {};

  for (const jc of allJcs) {
    const pieces = allPicsByJc.get(jc.id) ?? [];
    if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") {
      if (jc.completedDate && jc.completedDate.slice(0, 10) === today) {
        // Count PIECES the worker did, not JCs.
        let myPieces = 0;
        if (pieces.length > 0) {
          for (const s of pieces) {
            if (s.pic1Id === workerId || s.pic2Id === workerId) myPieces++;
          }
        } else if (jc.pic1Id === workerId || jc.pic2Id === workerId) {
          myPieces = 1;
        }
        if (myPieces > 0) {
          doneToday += myPieces;
          const deptCode = jc.departmentCode ?? "";
          doneByDept[deptCode] = (doneByDept[deptCode] ?? 0) + myPieces;
        }
      }
    } else if (jc.status === "IN_PROGRESS") {
      inProgress += 1;
    } else if (jc.status === "WAITING" || jc.status === "PAUSED") {
      pending += 1;
    }
  }

  let earningsSen = 0;
  for (const [deptCode, count] of Object.entries(doneByDept)) {
    earningsSen += (PIECE_RATE_SEN[deptCode] ?? 0) * count;
  }

  return c.json({
    success: true,
    data: {
      date: today,
      worker: {
        id: worker.id,
        empNo: worker.empNo,
        name: worker.name,
        departmentCode: worker.departmentCode ?? "",
      },
      attendance: attendance
        ? {
            clockIn: attendance.clockIn,
            clockOut: attendance.clockOut,
            // Live computation: when worker is clocked IN but not OUT yet,
            // workingMinutes = 0 in DB until clockOut runs. Show ticking
            // working time on the home page instead of a static 0.
            workingMinutes: (() => {
              if (attendance.workingMinutes > 0) return attendance.workingMinutes;
              if (!attendance.clockIn || attendance.clockOut) {
                return attendance.workingMinutes;
              }
              const [h, m] = attendance.clockIn.split(":").map(Number);
              const now = new Date();
              const total = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
              return Math.max(0, total);
            })(),
            status: attendance.status,
          }
        : null,
      pending,
      inProgress,
      doneToday,
      doneByDept,
      earningsSen,
    },
  });
});

// ============================================================
// POST /api/worker/clock
// Body: { action: 'CLOCK_IN' | 'CLOCK_OUT' }
// ============================================================
type DepartmentRow = { id: string; shortName: string };

app.post("/clock", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  if (action !== "CLOCK_IN" && action !== "CLOCK_OUT") {
    return c.json({ success: false, error: "Invalid action" }, 400);
  }

  const date = todayYmd();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;

  const existing = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE employeeId = ? AND date = ?",
  )
    .bind(worker.id, date)
    .first<AttendanceRow>();

  if (action === "CLOCK_IN") {
    if (existing) {
      // Idempotent — if a clockIn already exists, leave it; just ensure
      // status is PRESENT.
      if (!existing.clockIn) {
        await c.var.DB.prepare(
          "UPDATE attendance_records SET clockIn = ?, status = 'PRESENT' WHERE id = ?",
        )
          .bind(time, existing.id)
          .run();
      } else {
        await c.var.DB.prepare(
          "UPDATE attendance_records SET status = 'PRESENT' WHERE id = ?",
        )
          .bind(existing.id)
          .run();
      }
      const row = await c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE id = ?",
      )
        .bind(existing.id)
        .first<AttendanceRow>();
      return c.json({ success: true, data: row });
    }

    const dept = worker.departmentId
      ? await c.var.DB.prepare(
          "SELECT id, shortName FROM departments WHERE id = ?",
        )
          .bind(worker.departmentId)
          .first<DepartmentRow>()
      : null;
    const id = genId("att");
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
    return c.json({ success: true, data: row });
  }

  // CLOCK_OUT
  if (!existing) {
    return c.json(
      { success: false, error: "No clock-in record for today" },
      400,
    );
  }
  let workingMinutes = 0;
  let productionTimeMinutes = 0;
  let efficiencyPct = 0;
  let overtimeMinutes = 0;
  if (existing.clockIn) {
    const [inH, inM] = existing.clockIn.split(":").map(Number);
    const [outH, outM] = time.split(":").map(Number);
    const total = outH * 60 + outM - (inH * 60 + inM);
    workingMinutes = Math.max(0, total);
    productionTimeMinutes = Math.max(0, Math.round(total * 0.85));
    const standardMinutes = (worker.workingHoursPerDay || 9) * 60;
    efficiencyPct = standardMinutes > 0
      ? Math.round((productionTimeMinutes / standardMinutes) * 100)
      : 0;
    overtimeMinutes = Math.max(0, total - standardMinutes);
  }
  await c.var.DB.prepare(
    `UPDATE attendance_records
       SET clockOut = ?, workingMinutes = ?, productionTimeMinutes = ?,
           efficiencyPct = ?, overtimeMinutes = ?
     WHERE id = ?`,
  )
    .bind(
      time,
      workingMinutes,
      productionTimeMinutes,
      efficiencyPct,
      overtimeMinutes,
      existing.id,
    )
    .run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE id = ?",
  )
    .bind(existing.id)
    .first<AttendanceRow>();
  return c.json({ success: true, data: row });
});

// ============================================================
// GET /api/worker/history?from=YYYY-MM-DD&to=YYYY-MM-DD
// Defaults: last 30 days inclusive of today.
// ============================================================
app.get("/history", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;
  const hoursPerDay =
    (auth.worker as { workingHoursPerDay?: number }).workingHoursPerDay ?? 9;

  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const thirtyAgo = new Date(today.getTime() - 30 * 86400000);
  const defaultFrom = thirtyAgo.toISOString().slice(0, 10);
  const fromStr = (c.req.query("from") || defaultFrom).slice(0, 10);
  const toStr = (c.req.query("to") || defaultTo).slice(0, 10);

  // ---- attendance ----
  const attRes = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE employeeId = ? AND date >= ? AND date <= ? ORDER BY date DESC",
  )
    .bind(workerId, fromStr, toStr)
    .all<AttendanceRow>();

  // ---- working_hour_entries (manual admin grid) — source of truth for WORK HRS ----
  // Wei Siang fills hours via the admin Working Hours grid which writes to
  // working_hour_entries (per worker / date / departmentCode / category, decimal
  // hours). The Clock-In/Out flow that populates attendance_records.workingMinutes
  // is gated off until rollout (see commit a803ca9), so attendance.workingMinutes
  // is typically 0. Sum hours per date and let working_hour_entries take precedence
  // over attendance clock-time wherever both exist.
  const wheRes = await c.var.DB.prepare(
    "SELECT date, hours FROM working_hour_entries WHERE workerId = ? AND date >= ? AND date <= ?",
  )
    .bind(workerId, fromStr, toStr)
    .all<{ date: string; hours: number }>();
  const wheMinutesByDate = new Map<string, number>();
  for (const r of wheRes.results ?? []) {
    const d = (r.date || "").slice(0, 10);
    if (!d) continue;
    const mins = Math.round((Number(r.hours) || 0) * 60);
    wheMinutesByDate.set(d, (wheMinutesByDate.get(d) ?? 0) + mins);
  }

  const standardMins = hoursPerDay * 60;
  const attendance = (attRes.results ?? []).map((r) => {
    const wheMins = wheMinutesByDate.get(r.date);
    // When working_hour_entries has data for the date, split into regular
    // (capped at workingHoursPerDay) and overtime — anything above the
    // standard day is OT. Workers + Wei Siang see the row split as
    // "9h work + 2h OT" instead of one bucket of 11h. Falls back to
    // attendance_records numbers for dates that pre-date the entries.
    let workingMinutes = r.workingMinutes;
    let overtimeMinutes = r.overtimeMinutes;
    if (wheMins != null) {
      workingMinutes = Math.min(wheMins, standardMins);
      overtimeMinutes = Math.max(0, wheMins - standardMins);
    }
    return {
      date: r.date,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      workingMinutes,
      productionTimeMinutes: r.productionTimeMinutes,
      efficiencyPct: r.efficiencyPct,
      overtimeMinutes,
      status: r.status,
    };
  });

  // ---- completed job cards in range ----
  // First: every JC the worker touches that's COMPLETED/TRANSFERRED inside
  // [fromStr, toStr].  Two paths to "mine" (legacy + piecePics).
  const myJcsLegacy = await c.var.DB.prepare(
    `SELECT * FROM job_cards
       WHERE (pic1Id = ? OR pic2Id = ?)
         AND status IN ('COMPLETED','TRANSFERRED')`,
  )
    .bind(workerId, workerId)
    .all<JobCardRow>();

  const myPicsRes = await c.var.DB.prepare(
    "SELECT * FROM piece_pics WHERE pic1Id = ? OR pic2Id = ?",
  )
    .bind(workerId, workerId)
    .all<PiecePicRow>();
  const myPics = myPicsRes.results ?? [];

  const legacyIds = new Set((myJcsLegacy.results ?? []).map((j) => j.id));
  const extraJcIds = Array.from(
    new Set(myPics.map((p) => p.jobCardId).filter((id) => !legacyIds.has(id))),
  );
  let extraJcs: JobCardRow[] = [];
  if (extraJcIds.length > 0) {
    const placeholders = extraJcIds.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT * FROM job_cards WHERE id IN (${placeholders})
         AND status IN ('COMPLETED','TRANSFERRED')`,
    )
      .bind(...extraJcIds)
      .all<JobCardRow>();
    extraJcs = r.results ?? [];
  }
  const allJcs = [...(myJcsLegacy.results ?? []), ...extraJcs];

  // Filter by completedDate range; load all piece_pics for these JCs so the
  // share calc has full picCount info.
  const inRangeJcs = allJcs.filter((jc) => {
    const d = (jc.completedDate || "").slice(0, 10);
    if (!d) return false;
    return d >= fromStr && d <= toStr;
  });

  let allPics: PiecePicRow[] = [];
  if (inRangeJcs.length > 0) {
    const ids = inRangeJcs.map((j) => j.id);
    const placeholders = ids.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders})`,
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

  // Resolve PO metadata for label rendering on the frontend.
  const poIds = Array.from(new Set(inRangeJcs.map((j) => j.productionOrderId)));
  const posById = new Map<string, ProductionOrderRow>();
  if (poIds.length > 0) {
    const placeholders = poIds.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT id, poNo, productCode, productName, itemCategory, sizeLabel FROM production_orders WHERE id IN (${placeholders})`,
    )
      .bind(...poIds)
      .all<ProductionOrderRow>();
    for (const p of r.results ?? []) posById.set(p.id, p);
  }

  type CompletedCard = {
    jobCardId: string;
    orderPoNo: string;
    productCode: string;
    productName: string;
    departmentCode: string;
    estMinutes: number;
    actualMinutes: number | null;
    myMinutes: number;
    piecesWorked: number;
    piecesShared: number;
    totalPieces: number;
    completedDate: string | null;
    role: "PIC1" | "PIC2" | "MIXED";
    wipLabel?: string;
    wipCode?: string;
    itemCategory?: string;
    sizeLabel?: string;
    // Co-PICs the worker shared this JC with (id + name). Empty when solo.
    sharedWith: Array<{ id: string; name: string }>;
  };
  // Resolve the names of every co-PIC that appears anywhere in this batch
  // so we can attach them to each completed card. Cheap one-shot lookup.
  const coPicIds = new Set<string>();
  for (const jc of inRangeJcs) {
    const pieces = picsByJc.get(jc.id) ?? [];
    if (pieces.length > 0) {
      for (const s of pieces) {
        if (s.pic1Id && s.pic1Id !== workerId) coPicIds.add(s.pic1Id);
        if (s.pic2Id && s.pic2Id !== workerId) coPicIds.add(s.pic2Id);
      }
    } else {
      if (jc.pic1Id && jc.pic1Id !== workerId) coPicIds.add(jc.pic1Id);
      if (jc.pic2Id && jc.pic2Id !== workerId) coPicIds.add(jc.pic2Id);
    }
  }
  const coPicNameById = new Map<string, string>();
  if (coPicIds.size > 0) {
    const ids = Array.from(coPicIds);
    const placeholders = ids.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT id, name FROM workers WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ id: string; name: string }>();
    for (const row of r.results ?? []) coPicNameById.set(row.id, row.name);
  }

  const completed: CompletedCard[] = [];
  for (const jc of inRangeJcs) {
    const pieces = picsByJc.get(jc.id) ?? [];
    let myMinutes = 0;
    let piecesWorked = 0;
    let piecesShared = 0;
    const sharedIds = new Set<string>();
    let role: "PIC1" | "PIC2" | "MIXED" = "PIC1";
    const rolesSeen = new Set<"PIC1" | "PIC2">();

    if (pieces.length > 0) {
      const perPieceMinutes = jc.estMinutes || 0;
      for (const s of pieces) {
        const isPic1 = s.pic1Id === workerId;
        const isPic2 = s.pic2Id === workerId;
        if (!isPic1 && !isPic2) continue;
        const picCount = (s.pic1Id ? 1 : 0) + (s.pic2Id ? 1 : 0);
        myMinutes += perPieceMinutes / Math.max(1, picCount);
        piecesWorked++;
        if (picCount >= 2) {
          piecesShared++;
          if (isPic1 && s.pic2Id) sharedIds.add(s.pic2Id);
          if (isPic2 && s.pic1Id) sharedIds.add(s.pic1Id);
        }
        if (isPic1) rolesSeen.add("PIC1");
        if (isPic2) rolesSeen.add("PIC2");
      }
      if (piecesWorked === 0) continue;
      role =
        rolesSeen.size === 2
          ? "MIXED"
          : rolesSeen.has("PIC2")
            ? "PIC2"
            : "PIC1";
    } else {
      // Legacy path
      if (jc.pic1Id !== workerId && jc.pic2Id !== workerId) continue;
      const coPicCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
      myMinutes = (jc.estMinutes || 0) / Math.max(1, coPicCount);
      piecesWorked = 1;
      piecesShared = coPicCount >= 2 ? 1 : 0;
      role = jc.pic1Id === workerId ? "PIC1" : "PIC2";
      if (jc.pic1Id && jc.pic1Id !== workerId) sharedIds.add(jc.pic1Id);
      if (jc.pic2Id && jc.pic2Id !== workerId) sharedIds.add(jc.pic2Id);
    }

    const po = posById.get(jc.productionOrderId);
    completed.push({
      jobCardId: jc.id,
      orderPoNo: po?.poNo ?? "",
      productCode: po?.productCode ?? "",
      productName: po?.productName ?? "",
      departmentCode: jc.departmentCode ?? "",
      estMinutes: jc.estMinutes,
      actualMinutes: jc.actualMinutes,
      myMinutes: Math.round(myMinutes),
      piecesWorked,
      piecesShared,
      totalPieces: pieces.length || (jc.wipQty || 1),
      completedDate: jc.completedDate,
      role,
      wipLabel: jc.wipLabel ?? undefined,
      wipCode: jc.wipCode ?? undefined,
      itemCategory: po?.itemCategory ?? undefined,
      sizeLabel: po?.sizeLabel ?? undefined,
      sharedWith: Array.from(sharedIds).map((id) => ({
        id,
        name: coPicNameById.get(id) ?? id,
      })),
    });
  }
  completed.sort((a, b) =>
    (b.completedDate || "").localeCompare(a.completedDate || ""),
  );

  // ---- per-day rollup ----
  type DailyRow = {
    date: string;
    departmentName: string;
    workingMinutes: number;
    productionMinutes: number;
  };
  const dailyMap = new Map<string, DailyRow>();
  for (const r of attendance) {
    // attendance.workingMinutes was already overridden above when a
    // working_hour_entries total exists for the date.
    dailyMap.set(r.date, {
      date: r.date,
      departmentName: "",
      workingMinutes: r.workingMinutes,
      productionMinutes: 0,
    });
  }
  // Days that have working_hour_entries but no attendance row at all still need
  // to surface in the rollup so WORK HRS isn't dropped.
  for (const [d, mins] of wheMinutesByDate) {
    if (dailyMap.has(d)) continue;
    dailyMap.set(d, {
      date: d,
      departmentName: "",
      workingMinutes: mins,
      productionMinutes: 0,
    });
  }
  for (const c2 of completed) {
    const d = (c2.completedDate || "").slice(0, 10);
    if (!d) continue;
    if (d < fromStr || d > toStr) continue;
    const prev =
      dailyMap.get(d) ?? {
        date: d,
        departmentName: "",
        workingMinutes: wheMinutesByDate.get(d) ?? 0,
        productionMinutes: 0,
      };
    prev.productionMinutes += c2.myMinutes || 0;
    if (!prev.departmentName) prev.departmentName = c2.departmentCode;
    dailyMap.set(d, prev);
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // workedMinutes / overtimeMinutes — split per date once we know which side
  // (working_hour_entries vs attendance clock-time) wins. Per-date split:
  //   • From WHE: regular = min(hours, hoursPerDay), OT = max(0, hours - hoursPerDay)
  //   • Fallback to attendance_records.workingMinutes / overtimeMinutes when
  //     no manual entry exists.
  // Union both date sets so dates that appear in only one source still count.
  const workedDates = new Set<string>();
  for (const r of attendance) workedDates.add(r.date);
  for (const d of wheMinutesByDate.keys()) workedDates.add(d);
  const attRowByDate = new Map<string, typeof attendance[number]>();
  for (const r of attendance) attRowByDate.set(r.date, r);
  let workedMinutes = 0;
  let overtimeMinutes = 0;
  for (const d of workedDates) {
    const wheMins = wheMinutesByDate.get(d);
    if (wheMins != null) {
      workedMinutes += Math.min(wheMins, standardMins);
      overtimeMinutes += Math.max(0, wheMins - standardMins);
    } else {
      const row = attRowByDate.get(d);
      workedMinutes += row?.workingMinutes ?? 0;
      overtimeMinutes += row?.overtimeMinutes ?? 0;
    }
  }
  const productionMinutes = completed.reduce(
    (s, r) => s + (r.myMinutes || 0),
    0,
  );
  const totals = {
    days: workedDates.size,
    workedMinutes,
    productionMinutes,
    overtimeMinutes,
    completedCount: completed.length,
    efficiencyPct:
      workedMinutes > 0
        ? Math.round((productionMinutes / workedMinutes) * 100)
        : 0,
  };

  return c.json({
    success: true,
    data: {
      range: { from: fromStr, to: toStr },
      daily,
      attendance,
      completed,
      totals,
    },
  });
});

// ============================================================
// GET /api/worker/payslips
//
// Read-only — does NOT recompute the current-month estimate (admin-side
// /api/payslips POST already does that on demand).  Returns
//   { current: <stub-zero-row>, history: [<payslip rows>] }
// where each history row aliases payslips.* into the camelCase shape the
// /worker/pay frontend expects (basicSen, grossSen, netSen, ...).
//
// `current` is provided as a zeroed shell rather than null because the
// frontend's runtime parser (asPayData) requires it to be a record.
// ============================================================
type PayslipRow = {
  id: string;
  employeeId: string;
  period: string;
  basicSalarySen: number;
  totalOtSen: number;
  allowancesSen: number;
  grossPaySen: number;
  netPaySen: number;
  epfEmployeeSen: number;
  socsoEmployeeSen: number;
  eisEmployeeSen: number;
  pcbSen: number;
};

app.get("/payslips", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;

  const res = await c.var.DB.prepare(
    `SELECT id, employeeId, period, basicSalarySen, totalOtSen, allowancesSen,
            grossPaySen, netPaySen, epfEmployeeSen, socsoEmployeeSen,
            eisEmployeeSen, pcbSen
       FROM payslips
      WHERE employeeId = ?
      ORDER BY period DESC`,
  )
    .bind(workerId)
    .all<PayslipRow>();

  const history = (res.results ?? []).map((r) => ({
    id: r.id,
    period: r.period,
    basicSen: r.basicSalarySen,
    grossSen: r.grossPaySen,
    netSen: r.netPaySen,
    allowancesSen: r.allowancesSen,
    overtimeSen: r.totalOtSen,
    epfEeSen: r.epfEmployeeSen,
    socsoEeSen: r.socsoEmployeeSen,
    eisEeSen: r.eisEmployeeSen,
    taxSen: r.pcbSen,
  }));

  // Live current-month estimate so the worker sees something between
  // monthly payroll runs.  Same prorated-basic + OT 1.5x + piece bonus
  // formula the mock used.  Never overrides what's in `history` — once
  // the admin generates the period's payslip, the row in `history` is
  // the source of truth and this `current` becomes a redundant preview.
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthPrefix = `${period}-`;

  const worker = auth.worker as {
    basicSalarySen?: number;
    workingDaysPerMonth?: number;
    workingHoursPerDay?: number;
  };
  const basicSalarySen = worker.basicSalarySen ?? 0;
  const daysInMonth = worker.workingDaysPerMonth ?? 26;
  const hoursPerDay = worker.workingHoursPerDay ?? 8;

  // ---------------------------------------------------------------
  // Salary model (Wei Siang 2026-05-10):
  //   • Workers see FULL monthly salary (e.g. RM 2050) as the baseline
  //     unless they're absent.
  //   • Each absent workday inside the month-to-date window deducts
  //     one daily rate (basicSalarySen / workingDaysPerMonth).
  //   • A workday is "absent" when no working_hour_entries row exists
  //     for that date — workers no longer clock in/out, so the office
  //     fill-in IS the source of truth.
  //   • OT comes from working_hour_entries too: hours in excess of
  //     workingHoursPerDay per date count as OT (1.5× hourly rate).
  //   • Piece bonus has been retired.  Replaced by an efficiency
  //     allowance line (formula pending — currently 0).
  // ---------------------------------------------------------------
  const wheRes = await c.var.DB.prepare(
    `SELECT date, hours FROM working_hour_entries
      WHERE workerId = ? AND date LIKE ?`,
  )
    .bind(workerId, `${monthPrefix}%`)
    .all<{ date: string; hours: number }>();
  const hoursByDate = new Map<string, number>();
  for (const r of wheRes.results ?? []) {
    hoursByDate.set(r.date, (hoursByDate.get(r.date) ?? 0) + Number(r.hours));
  }
  const workedDays = hoursByDate.size;

  // Public holidays — stored in kv_config['public_holidays'] as a JSON
  // array of YYYY-MM-DD strings. Office fills these via the Working Hours
  // tab so that 1 May / Hari Raya / etc. don't get charged as absences.
  const phRes = await c.var.DB.prepare(
    "SELECT value FROM kv_config WHERE key = ?",
  )
    .bind("public_holidays")
    .first<{ value: string }>();
  const publicHolidays = new Set<string>();
  if (phRes?.value) {
    try {
      const parsed = JSON.parse(phRes.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            publicHolidays.add(d);
          }
        }
      }
    } catch { /* malformed payload — treat as no holidays */ }
  }

  // Count workdays elapsed in this month up to today (Mon–Sat),
  // excluding declared public holidays.
  const monthYear = now.getFullYear();
  const monthIdx = now.getMonth(); // 0-based
  const todayDate = now.getDate();
  let workdaysElapsed = 0;
  for (let d = 1; d <= todayDate; d++) {
    const dow = new Date(monthYear, monthIdx, d).getDay(); // 0 = Sun
    if (dow === 0) continue; // Sunday off
    const iso = `${monthYear}-${String(monthIdx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (publicHolidays.has(iso)) continue; // public holiday
    workdaysElapsed++;
  }
  const absentDays = Math.max(0, workdaysElapsed - workedDays);

  const dailyRateSen = daysInMonth > 0 ? basicSalarySen / daysInMonth : 0;
  const hourlyRateSen = hoursPerDay > 0 ? dailyRateSen / hoursPerDay : 0;
  const basicEarnedSen = Math.max(
    0,
    Math.round(basicSalarySen - absentDays * dailyRateSen),
  );

  // OT = hours per date above the standard workingHoursPerDay.
  let otMinutes = 0;
  for (const h of hoursByDate.values()) {
    if (h > hoursPerDay) otMinutes += Math.round((h - hoursPerDay) * 60);
  }
  const otSen = Math.round((otMinutes / 60) * hourlyRateSen * 1.5);

  // Efficiency allowance — placeholder until Wei Siang specifies the
  // formula (likely: efficiency % thresholds → flat allowance).
  const efficiencyAllowanceSen = 0;

  return c.json({
    success: true,
    data: {
      current: {
        period,
        workedDays,
        absentDays,
        otMinutes,
        basicEarnedSen,
        otSen,
        efficiencyAllowanceSen,
        estimatedGrossSen: basicEarnedSen + otSen + efficiencyAllowanceSen,
      },
      history,
    },
  });
});

// ============================================================
// GET /api/worker/leaves
// ============================================================
type LeaveRow = {
  id: string;
  workerId: string;
  workerName: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string | null;
  approvedBy: string | null;
};

app.get("/leaves", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;

  const res = await c.var.DB.prepare(
    "SELECT * FROM leaves WHERE workerId = ? ORDER BY startDate DESC",
  )
    .bind(workerId)
    .all<LeaveRow>();
  const mine = (res.results ?? []).map((r) => ({
    id: r.id,
    workerId: r.workerId,
    workerName: r.workerName,
    type: r.type,
    startDate: r.startDate,
    endDate: r.endDate,
    days: r.days,
    status: r.status,
    reason: r.reason ?? "",
    approvedBy: r.approvedBy ?? undefined,
  }));

  // YTD usage
  const yearPrefix = String(new Date().getFullYear());
  const usedAnnual = mine
    .filter(
      (r) =>
        r.type === "ANNUAL" &&
        r.status === "APPROVED" &&
        r.startDate.startsWith(yearPrefix),
    )
    .reduce((s, r) => s + (r.days || 0), 0);
  const usedMedical = mine
    .filter(
      (r) =>
        r.type === "MEDICAL" &&
        r.status === "APPROVED" &&
        r.startDate.startsWith(yearPrefix),
    )
    .reduce((s, r) => s + (r.days || 0), 0);

  const annualEntitlement = 14;
  const medicalEntitlement = 14;

  return c.json({
    success: true,
    data: {
      balance: {
        annualRemaining: Math.max(0, annualEntitlement - usedAnnual),
        medicalRemaining: Math.max(0, medicalEntitlement - usedMedical),
        annualEntitlement,
        medicalEntitlement,
      },
      history: mine,
    },
  });
});

// ============================================================
// POST /api/worker/leaves
// ============================================================
app.post("/leaves", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const { type, startDate, endDate, reason } = body as {
    type?: string;
    startDate?: string;
    endDate?: string;
    reason?: string;
  };
  if (!type || !startDate || !endDate) {
    return c.json({ success: false, error: "Missing fields" }, 400);
  }
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) {
    return c.json({ success: false, error: "Invalid date range" }, 400);
  }
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;

  const id = genId("lv");
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO leaves (id, workerId, workerName, type, startDate, endDate,
       days, status, reason, approvedBy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, ?, ?)`,
  )
    .bind(
      id,
      worker.id,
      worker.name,
      type,
      startDate,
      endDate,
      days,
      reason ?? "",
      now,
      now,
    )
    .run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM leaves WHERE id = ?",
  )
    .bind(id)
    .first<LeaveRow>();
  return c.json({ success: true, data: row });
});

// ============================================================
// POST /api/worker/issues
// Body: { category, description, photoDataUrl? }
// ============================================================
type IssueRow = {
  id: string;
  workerId: string;
  category: string;
  description: string;
  photoDataUrl: string | null;
  reportedAt: string;
  status: string;
};

app.post("/issues", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const { category, description, photoDataUrl } = body as {
    category?: string;
    description?: string;
    photoDataUrl?: string;
  };
  if (!category || !description) {
    return c.json({ success: false, error: "Missing fields" }, 400);
  }
  const id = genId("iss");
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO worker_issues (id, workerId, category, description, photoDataUrl, reportedAt, status)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN')`,
  )
    .bind(
      id,
      worker.id,
      category,
      description,
      photoDataUrl ?? null,
      now,
    )
    .run();
  return c.json({ success: true, data: { id } });
});

// ============================================================
// GET /api/worker/issues  — last 20 of mine
// ============================================================
app.get("/issues", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;
  const res = await c.var.DB.prepare(
    "SELECT * FROM worker_issues WHERE workerId = ? ORDER BY reportedAt DESC LIMIT 20",
  )
    .bind(workerId)
    .all<IssueRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// ============================================================
// PATCH /api/worker/profile
// Body: { phone? }
// ============================================================
app.patch("/profile", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const { phone } = body as { phone?: string };
  if (typeof phone === "string") {
    await c.var.DB.prepare("UPDATE workers SET phone = ? WHERE id = ?")
      .bind(phone, worker.id)
      .run();
    return c.json({ success: true, data: { phone } });
  }
  return c.json({ success: true, data: { phone: worker.phone ?? "" } });
});

// ============================================================
// GET /api/worker/team-stats?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Operator Leader dashboard aggregator. Returns a per-(department × category)
// rollup of working minutes vs production minutes for every worker on the
// leader's teams.
//
// Authorization: only Operator Leaders get real data. Anyone else gets
// `{ isLeader: false, rows: [] }` (NOT 403) so the frontend can use this
// single endpoint to decide whether to render the Team card at all.
//
// Defaults: last 7 days inclusive of today when from/to omitted.
//
// Production-minutes formula (MVP, deliberately simple): for each JC matched
// by (departmentCode × itemCategory × completedDate in range), if ANY team
// worker is on it (legacy pic1/pic2 OR via piece_pics), credit the JC's full
// actualMinutes ?? estMinutes once. No double-counting per JC even when
// multiple team members shared it. Frontend can refine later if needed.
// ============================================================
app.get("/team-stats", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;

  // Date defaults: last 7 days inclusive.
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const sixDaysAgo = new Date(today.getTime() - 6 * 86400000);
  const defaultFrom = sixDaysAgo.toISOString().slice(0, 10);
  const fromStr = (c.req.query("from") || defaultFrom).slice(0, 10);
  const toStr = (c.req.query("to") || defaultTo).slice(0, 10);

  // Non-leaders short-circuit. Frontend uses isLeader:false to skip rendering
  // the Team card entirely; we still 200 OK so the request isn't an error.
  if ((worker.position ?? "") !== "Operator Leader") {
    return c.json({
      success: true,
      data: { isLeader: false, rows: [] },
    });
  }

  const leaderDepts = parseWorkerDepartmentCodes(
    worker.departmentCodes,
    worker.departmentCode,
  );
  if (leaderDepts.length === 0) {
    return c.json({
      success: true,
      data: { isLeader: true, range: { from: fromStr, to: toStr }, rows: [] },
    });
  }

  // ---- Resolve every team worker (active workers whose dept set intersects
  // the leader's). We pull ACTIVE workers and parse their JSON client-side
  // (≤50 active workers, brute force is fine).
  const allWorkersRes = await c.var.DB.prepare(
    "SELECT id, departmentCode, departmentCodes FROM workers WHERE status = 'ACTIVE'",
  ).all<{
    id: string;
    departmentCode: string | null;
    departmentCodes: string | null;
  }>();
  const allWorkers = allWorkersRes.results ?? [];

  // Map: deptCode -> Set of workerIds whose dept set contains it.
  const workersByDept = new Map<string, Set<string>>();
  for (const dc of leaderDepts) workersByDept.set(dc, new Set<string>());
  for (const w of allWorkers) {
    const codes = parseWorkerDepartmentCodes(
      w.departmentCodes,
      w.departmentCode,
    );
    for (const dc of leaderDepts) {
      if (codes.includes(dc)) workersByDept.get(dc)!.add(w.id);
    }
  }

  // Union of all team worker ids — used for the JC + WHE queries.
  const allTeamIds = new Set<string>();
  for (const set of workersByDept.values()) {
    for (const id of set) allTeamIds.add(id);
  }

  type CellKey = string; // `${deptCode}::${category}`
  const cellKey = (d: string, cat: string): CellKey => `${d}::${cat}`;
  const CATEGORIES: Array<"SOFA" | "BEDFRAME"> = ["SOFA", "BEDFRAME"];

  type Cell = {
    departmentCode: string;
    category: "SOFA" | "BEDFRAME";
    workingMinutes: number;
    productionMinutes: number;
    workerIds: Set<string>;
  };
  const cells = new Map<CellKey, Cell>();
  for (const dc of leaderDepts) {
    for (const cat of CATEGORIES) {
      cells.set(cellKey(dc, cat), {
        departmentCode: dc,
        category: cat,
        workingMinutes: 0,
        productionMinutes: 0,
        workerIds: new Set<string>(),
      });
    }
  }

  // ---- Working minutes: sum hours*60 from working_hour_entries.
  // Skip the query entirely when the leader has no team members.
  if (allTeamIds.size > 0) {
    const idArr = Array.from(allTeamIds);
    const idPh = idArr.map(() => "?").join(",");
    const deptPh = leaderDepts.map(() => "?").join(",");
    const wheRes = await c.var.DB.prepare(
      `SELECT workerId, departmentCode, category, hours
         FROM working_hour_entries
        WHERE workerId IN (${idPh})
          AND departmentCode IN (${deptPh})
          AND date >= ? AND date <= ?`,
    )
      .bind(...idArr, ...leaderDepts, fromStr, toStr)
      .all<{
        workerId: string;
        departmentCode: string;
        category: string | null;
        hours: number;
      }>();
    for (const r of wheRes.results ?? []) {
      const cat = (r.category ?? "") as "SOFA" | "BEDFRAME";
      if (cat !== "SOFA" && cat !== "BEDFRAME") continue;
      const cell = cells.get(cellKey(r.departmentCode, cat));
      if (!cell) continue;
      cell.workingMinutes += Math.round((Number(r.hours) || 0) * 60);
      cell.workerIds.add(r.workerId);
    }
  }

  // ---- Production minutes: completed/transferred JCs in range whose dept
  // matches a leader dept and whose linked PO has matching itemCategory.
  // We pull every candidate JC by (departmentCode + status + completedDate),
  // then filter by team membership and join to PO for itemCategory.
  if (allTeamIds.size > 0) {
    const deptPh = leaderDepts.map(() => "?").join(",");
    const jcRes = await c.var.DB.prepare(
      `SELECT id, productionOrderId, departmentCode, status, pic1Id, pic2Id,
              completedDate, estMinutes, actualMinutes
         FROM job_cards
        WHERE departmentCode IN (${deptPh})
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completedDate >= ? AND completedDate <= ?`,
    )
      .bind(...leaderDepts, fromStr, toStr)
      .all<{
        id: string;
        productionOrderId: string;
        departmentCode: string | null;
        status: string;
        pic1Id: string | null;
        pic2Id: string | null;
        completedDate: string | null;
        estMinutes: number;
        actualMinutes: number | null;
      }>();
    const candidateJcs = jcRes.results ?? [];

    // Pull piece_pics for these JCs in one shot so we can detect team
    // membership via the per-piece path too (not just legacy pic1/pic2).
    let allPics: PiecePicRow[] = [];
    if (candidateJcs.length > 0) {
      const ids = candidateJcs.map((j) => j.id);
      const ph = ids.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT * FROM piece_pics WHERE jobCardId IN (${ph})`,
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

    // Resolve PO itemCategory in one batch.
    const poIds = Array.from(
      new Set(candidateJcs.map((j) => j.productionOrderId)),
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

    for (const jc of candidateJcs) {
      const dc = jc.departmentCode ?? "";
      const cat = (poCategoryById.get(jc.productionOrderId) ?? "") as
        | "SOFA"
        | "BEDFRAME";
      if (cat !== "SOFA" && cat !== "BEDFRAME") continue;
      const cell = cells.get(cellKey(dc, cat));
      if (!cell) continue;

      // Identify the team workers on this JC (legacy + piece_pics paths).
      const onJc = new Set<string>();
      if (jc.pic1Id && allTeamIds.has(jc.pic1Id)) onJc.add(jc.pic1Id);
      if (jc.pic2Id && allTeamIds.has(jc.pic2Id)) onJc.add(jc.pic2Id);
      for (const p of picsByJc.get(jc.id) ?? []) {
        if (p.pic1Id && allTeamIds.has(p.pic1Id)) onJc.add(p.pic1Id);
        if (p.pic2Id && allTeamIds.has(p.pic2Id)) onJc.add(p.pic2Id);
      }
      if (onJc.size === 0) continue;

      // Credit the JC's full minutes once (no double-count when multiple
      // team workers share it). actualMinutes wins when populated.
      const mins = jc.actualMinutes ?? jc.estMinutes ?? 0;
      cell.productionMinutes += mins;
      for (const id of onJc) cell.workerIds.add(id);
    }
  }

  const rows = Array.from(cells.values()).map((cell) => ({
    departmentCode: cell.departmentCode,
    category: cell.category,
    workingMinutes: cell.workingMinutes,
    productionMinutes: cell.productionMinutes,
    efficiencyPct:
      cell.workingMinutes > 0
        ? Math.round((cell.productionMinutes / cell.workingMinutes) * 100)
        : 0,
    workerCount: cell.workerIds.size,
  }));

  return c.json({
    success: true,
    data: {
      isLeader: true,
      range: { from: fromStr, to: toStr },
      rows,
    },
  });
});

export default app;
