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
  position: string | null;
  phone: string | null;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
};

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
    "SELECT id, empNo, name, departmentId, departmentCode, position, phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth FROM workers WHERE id = ?",
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
            workingMinutes: attendance.workingMinutes,
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
  const attendance = (attRes.results ?? []).map((r) => ({
    date: r.date,
    clockIn: r.clockIn,
    clockOut: r.clockOut,
    workingMinutes: r.workingMinutes,
    productionTimeMinutes: r.productionTimeMinutes,
    efficiencyPct: r.efficiencyPct,
    overtimeMinutes: r.overtimeMinutes,
    status: r.status,
  }));

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
  };
  const completed: CompletedCard[] = [];
  for (const jc of inRangeJcs) {
    const pieces = picsByJc.get(jc.id) ?? [];
    let myMinutes = 0;
    let piecesWorked = 0;
    let piecesShared = 0;
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
        if (picCount >= 2) piecesShared++;
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
    dailyMap.set(r.date, {
      date: r.date,
      departmentName: "",
      workingMinutes: r.workingMinutes,
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
        workingMinutes: 0,
        productionMinutes: 0,
      };
    prev.productionMinutes += c2.myMinutes || 0;
    if (!prev.departmentName) prev.departmentName = c2.departmentCode;
    dailyMap.set(d, prev);
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const workedMinutes = attendance.reduce((s, r) => s + r.workingMinutes, 0);
  const productionMinutes = completed.reduce(
    (s, r) => s + (r.myMinutes || 0),
    0,
  );
  const totals = {
    days: attendance.length,
    workedMinutes,
    productionMinutes,
    overtimeMinutes: attendance.reduce((s, r) => s + r.overtimeMinutes, 0),
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

  // Zeroed `current` row — keeps the shape the frontend's runtime parser
  // expects without re-doing the admin payroll math here.  When the
  // operator runs the monthly payslip generation, the new row shows up
  // in `history` immediately.
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return c.json({
    success: true,
    data: {
      current: {
        period,
        workedDays: 0,
        otMinutes: 0,
        basicEarnedSen: 0,
        otSen: 0,
        pieceBonusSen: 0,
        estimatedGrossSen: 0,
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

export default app;
