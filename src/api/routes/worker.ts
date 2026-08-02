// ============================================================
// Worker portal — per-worker scoped endpoints under /api/worker/*.
//
// Postgres-backed surface for the /worker mobile portal. (The earlier
// in-memory mock under src/api/routes-mock/ was deleted in BUG-2026-05-28-003.)
// Every endpoint is gated by X-Worker-Token via resolveWorkerToken
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
import { computeMonthlyLabor, computeAttendanceDayDetail, absenceCutoffDay, effectiveSalarySenForMonth } from "../../lib/labor-engine";
import { jcMinutesTotal } from "../../lib/job-card-minutes";
import { deriveBarcodeToken, deptOfBarcodeToken, isBarcodeToken } from "../../lib/job-card-id";
import { computeMonthlyEfficiencyByWorker, resolveEfficiencyAllowanceSen, monthBounds } from "../lib/efficiency-allowance";
import {
  ensureWorkerPerfIndices,
  ensureWorkerSnapshotTables,
  memoizedMonthlyEfficiency,
  withWorkerSnapshot,
  loadActiveBomRowsMemoized,
} from "../lib/worker-perf";
import { maybeApplyAutoPunchDock } from "../lib/attendance-deduct";
import { applyPackingRack } from "../lib/packing-rack-write";
import { aggregateWipTimes } from "../lib/wip-times-core";
import {
  recordDeptScan,
  autofillWorkingHoursFromPunch,
} from "../lib/punch-autofill";
import { loadPayRuleVersions } from "../lib/pay-rules-store";
import { resolvePayRulesAsOf, toAttendanceRules, payrollDayRateSen, payrollHourDivisor } from "../../lib/pay-rules";
import { computeAttendanceDay, hhmmToMinutes, otMinutesAtLeastMinimum } from "../../lib/attendance-rules";
import {
  rowToMinimalPO,
  // Aliased: worker.ts already has its own slimmer local ProductionOrderRow /
  // JobCardRow (used by /today etc.). These are the FULL row shapes that
  // rowToMinimalPO consumes — a SELECT * returns them at runtime.
  type ProductionOrderRow as PoRowFull,
  type JobCardRow as JcRowFull,
  // Per-piece slot row shape — reused so scan-lookup can hand piece_pics to
  // rowToMinimalPO for the phone's "already done" pre-check (BUG-2026-06-08).
  type PiecePicRow as ProdPiecePicRow,
} from "./production-orders";
import {
  SupabaseStorageNotConfiguredError,
  getFile,
  signedDownloadUrl,
} from "../lib/supabase-storage";
import { DEFAULT_ORG_ID } from "../lib/tenant";

const app = new Hono<Env>();

// Shape of the file_assets columns the worker announcement-file proxy needs.
// file_assets predates the snake_case rule and is queried with bare camelCase
// names (matches src/api/routes/files.ts), so the PG driver returns them as-is.
type WorkerFileAssetRow = {
  id: string;
  resourceType: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
};

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
  otMultiplier: number;
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
    "SELECT id, empNo, name, departmentId, departmentCode, departmentCodes, categories, position, phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth, otMultiplier FROM workers WHERE id = ?",
  )
    .bind(workerId)
    .first<WorkerRow>();
  if (!w) {
    return {
      ok: false,
      response: c.json({ success: false, error: "Worker not found" }, 404),
    };
  }
  // A worker who is no longer ACTIVE (RESIGNED / INACTIVE) is locked out of the
  // ENTIRE worker app — every request is rejected, not just fresh logins. This
  // catches a phone that was already signed in before the worker was resigned
  // (the login gate alone wouldn't kick an existing session).
  if (w.status !== "ACTIVE") {
    return {
      ok: false,
      response: c.json(
        { success: false, error: "Employee account inactive" },
        403,
      ),
    };
  }
  return { ok: true, workerId, worker: w };
}

// The worker's CURRENT department (owner 2026-06-26 — unified scan model):
// the dept of their MOST RECENT dept-QR scan today, else the attendance punch
// dept, else their home departmentCode. This is the single source of truth for
// "what can this worker scan/complete right now" — a sticker for any OTHER dept
// is blocked. Mirrors how dept-scan-split derives the labour buckets, so the
// scan boundary and the time attribution agree.
async function getCurrentDeptForWorker(
  db: D1Database,
  workerId: string,
  date: string,
  homeDept: string | null | undefined,
): Promise<string> {
  try {
    const ds = await db
      .prepare(
        "SELECT departmentcode FROM dept_scan_events WHERE workerid = ? AND date = ? ORDER BY atmin DESC LIMIT 1",
      )
      .bind(workerId, date)
      .first<{ departmentcode: string | null }>();
    if (ds?.departmentcode) return ds.departmentcode.trim().toUpperCase();
  } catch {
    /* table may be absent pre-ensure — fall through to punch/home */
  }
  try {
    const at = await db
      .prepare(
        "SELECT departmentCode FROM attendance_records WHERE employeeId = ? AND date = ? ORDER BY clockIn DESC LIMIT 1",
      )
      .bind(workerId, date)
      .first<{ departmentCode: string | null }>();
    if (at?.departmentCode) return at.departmentCode.trim().toUpperCase();
  } catch {
    /* fall through */
  }
  return (homeDept || "").trim().toUpperCase();
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// Malaysia local clock (UTC+8, no DST). The Workers runtime is UTC, so a raw
// `new Date()` is 8h behind Malaysia: a pre-8am "today" rolls back to yesterday,
// and a 9am punch would stamp "01:00". Shift to UTC+8 first, then read the UTC
// fields off the shifted instant. The punch clock and /today share this so they
// always agree on which calendar day "today" is.
function malaysiaNow(): Date {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
function todayYmd(): string {
  return malaysiaNow().toISOString().slice(0, 10);
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
  // Stored TOTAL production minutes for the JC (per-SET total for merged
  // FAB_CUT cards; per-unit × wipQty for other depts). SELECT * returns it;
  // used by the FAB_CUT per-piece-base calc in the /history breakdown.
  productionTimeMinutes: number | null;
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
// GET /api/worker/ann-files/:id/download
//
// Worker-token-authed proxy to an ANNOUNCEMENT attachment. The dashboard file
// route (/api/files/:id/download) sits behind the session-cookie gate, so the
// worker portal (X-Worker-Token only) can't reach it — that was why posted
// announcement photos/PDFs never rendered on the phone. Mirrors the dashboard
// download (302 to a short-lived signed URL, byte-stream fallback) but
// authenticates via the worker token and HARD-RESTRICTS to resourceType
// 'announcement' so it can never serve any other resource's files. Additive —
// the dashboard route is untouched. Path is /ann-files (NOT /announcements/...):
// /api/worker/announcements is a separate sub-app that would swallow that prefix.
// ============================================================
app.get("/ann-files/:id/download", async (c) => {
  // Auth: accept the worker token from the header (in-app fetch) OR a ?wt=
  // query param. A native <img>/<video>/<a download> load CANNOT set a custom
  // header, so without this they'd 401 ("Not authenticated") — that was why
  // announcement photos/PDFs failed to open on the phone. Scoped to this
  // read-only, announcement-files-only route, so the blast radius is tiny.
  const token = c.req.header("x-worker-token") || c.req.query("wt") || undefined;
  const workerId = await resolveWorkerToken(c.var.DB, token);
  if (!workerId) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT id, resourceType, filename, contentType, sizeBytes, r2Key FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, DEFAULT_ORG_ID)
    .first<WorkerFileAssetRow>();
  // Only announcement attachments are serveable here — anything else 404s so a
  // worker token can't be used to fish out arbitrary file_assets rows.
  if (!row || row.resourceType !== "announcement") {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  try {
    const url = await signedDownloadUrl(c.env, row.r2Key, 300);
    if (url) {
      return c.redirect(url, 302);
    }
    // Presigning unavailable — stream the bytes through the Worker.
    const obj = await getFile(c.env, row.r2Key);
    if (!obj) return c.json({ success: false, error: "Not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        // Inline so the phone renders photos in the grid / lightbox and opens
        // PDFs in the browser viewer. nosniff guards against polyglots.
        "Content-Disposition": `inline; filename="${(row.filename || "file").replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[worker/ann-file] download failed:", err);
    return c.json({ success: false, error: "download failed" }, 500);
  }
});

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
// GET /api/worker/wip-times?dept=<CODE> — a department's standard times.
//
// Owner 2026-06-26: workers "totally don't know" the standard minutes per WIP
// for their dept → disputes. This read-only reference shows ONLY their own
// department's numbers (filtered by workers.departmentCode). Shares the BOM
// walk + dedup + aggregate with the dashboard GET /api/wip-times via
// lib/wip-times-core (one source, no drift). Org-agnostic like the rest of
// this file (single-org). Returns the per-WIP standard minutes (bomMaxMinutes
// = the conservative limit; min==max for the common single-valued case).
//
// Multi-department (owner 2026-06-26): a worker in >1 department can pick which
// department's WIP times to view via ?dept=<CODE>. The request is validated
// against the worker's OWN department set (primary departmentCode + the parsed
// departmentCodes JSON array) — an unknown/foreign/absent dept silently falls
// back to the primary, so no caller can read a department they're not in. The
// payload also returns `departmentCodes` (the deduped set incl. primary) so the
// front-end can render the selector without a separate /me round-trip (and it's
// always fresh, unlike the login-time localStorage cache).
// ============================================================
app.get("/wip-times", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const primary = (auth.worker.departmentCode || "").trim().toUpperCase();
  // The worker's full department set: primary + the parsed JSON array, deduped,
  // upper-cased. parseWorkerDepartmentCodes already folds in the primary as a
  // fallback when the array is missing/empty.
  const deptSet = Array.from(
    new Set(
      parseWorkerDepartmentCodes(
        auth.worker.departmentCodes,
        auth.worker.departmentCode,
      )
        .map((d) => d.trim().toUpperCase())
        .filter((d) => d.length > 0),
    ),
  );
  // Honour ?dept=<CODE> only if it's one the worker actually belongs to;
  // otherwise default to the primary.
  const requested = (c.req.query("dept") || "").trim().toUpperCase();
  const dept =
    requested && deptSet.includes(requested) ? requested : primary;
  if (!dept) {
    return c.json({
      success: true,
      data: { department: "", departmentCodes: deptSet, rows: [] },
    });
  }
  const bomRows = await loadActiveBomRowsMemoized(c.var.DB);
  const agg = aggregateWipTimes(bomRows, { dept });
  const rows = agg.map((r) => ({
    wipLabel: r.wipLabel,
    wipType: r.wipType,
    itemCategory: r.itemCategory,
    minutes: r.bomMaxMinutes,
    productCount: r.productCount,
  }));
  return c.json({
    success: true,
    data: { department: dept, departmentCodes: deptSet, rows },
  });
});

// ============================================================
// GET /api/worker/current-dept — the worker's CURRENT department (owner
// 2026-06-26 unified scan model). The phone uses this to block scanning a
// sticker that belongs to a DIFFERENT department (it shows the "wrong
// department" popup instead of completing). Current dept = latest dept-QR scan
// today → punch dept → home dept.
// ============================================================
app.get("/current-dept", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const dept = await getCurrentDeptForWorker(
    c.var.DB,
    auth.workerId,
    todayYmd(),
    auth.worker.departmentCode,
  );
  return c.json({ success: true, data: { currentDept: dept } });
});

// ============================================================
// GET /api/worker/scan-lookup?q=<poNo|orderId|jobCardId>&dept=<DEPT>
//
// Read-only PO lookup for the /worker phone scanner. The scan page used to
// pull the WHOLE dashboard-only /api/production-orders list (multi-MB) and
// match client-side, which 401'd for an X-Worker-Token caller. This returns
// ONLY the PO(s) matching the scanned/typed term, in the exact rowToMinimalPO
// shape the scan page already consumes — so the lookup card never silently
// loses a field. `dept` trims each PO's jobCards to that department (the
// Fab Cut / Fab Sew sentinel path passes it); the client re-filters anyway,
// so it is purely a payload saver. LIMIT caps fan-out — a real scan is
// unambiguous. Exact (case-sensitive) match: the QR encodes the stored poNo
// verbatim; manual entry must type it as shown.
// ============================================================
app.get("/scan-lookup", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;

  const term = (c.req.query("q") ?? "").trim();
  if (!term) return c.json({ success: true, data: [] });
  const deptHint = (c.req.query("dept") ?? "").trim().toUpperCase() || null;

  // PO number / PO id first; fall back to a job-card id (other-dept per-piece
  // stickers encode the jc id directly in op=).
  let poRows =
    (
      await c.var.DB.prepare(
        "SELECT * FROM production_orders WHERE poNo = ? OR id = ? LIMIT 5",
      )
        .bind(term, term)
        .all<PoRowFull>()
    ).results ?? [];

  if (poRows.length === 0) {
    poRows =
      (
        await c.var.DB.prepare(
          `SELECT po.* FROM production_orders po
             JOIN job_cards jc ON jc.productionOrderId = po.id
            WHERE jc.id = ? LIMIT 5`,
        )
          .bind(term)
          .all<PoRowFull>()
      ).results ?? [];
  }

  // Schedule Code 128: the printed barcode is the SHORT token b<deptNN><7hash>,
  // which is NOT a stored id — resolve it by re-deriving deriveBarcodeToken
  // across that department's OPEN cards (the token's 2 digits = dept code).
  // Bounded by current WIP for one dept; works for new AND old cards alike, with
  // no id rewrite and no new column.
  if (poRows.length === 0 && isBarcodeToken(term)) {
    const deptCode = deptOfBarcodeToken(term);
    if (deptCode) {
      // Resolve the schedule Code 128 by re-deriving deriveBarcodeToken across
      // EVERY card in the department — INCLUDING completed ones, so re-scanning
      // a finished card surfaces it ("already done") instead of a baffling
      // "Not found" (Wei Siang 2026-06-17: token 0319032601 was a COMPLETED
      // WOOD_CUT card that the old `status <> 'COMPLETED'` filter hid → "Not
      // found"). The earlier all-status 500 ("出错了 / something went wrong") was
      // the `wipKey` column — a 60+ char BOM string pulled for every dept card,
      // which blew up the payload; it is no longer selected here, so the
      // candidate scan is just 3 small columns and safe at any status. The
      // try/catch + the wrapped response build below keep any hiccup graceful
      // (empty → "Not found"), never a 500.
      try {
        const cand =
          (
            await c.var.DB.prepare(
              `SELECT id, productionOrderId, departmentCode
                 FROM job_cards
                WHERE departmentCode = ?`,
            )
              .bind(deptCode)
              .all<{
                id: string;
                productionOrderId: string;
                departmentCode: string | null;
              }>()
          ).results ?? [];
        const hit = cand.find(
          (j) =>
            deriveBarcodeToken(j.id, j.departmentCode ?? deptCode) === term,
        );
        if (hit) {
          poRows =
            (
              await c.var.DB.prepare(
                "SELECT * FROM production_orders WHERE id = ? LIMIT 1",
              )
                .bind(hit.productionOrderId)
                .all<PoRowFull>()
            ).results ?? [];
        }
      } catch (e) {
        console.warn("[scan-lookup] barcode-token resolve failed:", e);
      }
    }
  }

  // FG-PACKING fallback (owner 2026-06-26: "Not found: FG-PACKING / SO-2604-206-04").
  // That sticker carries ONLY po=<poNo> — unlike dept stickers (op=<job_card.id>,
  // rescued by the jc-id path above), it has NO job-card-id to fall back on, and
  // the matches above are exact poNo/id only. So if the printed poNo DRIFTED from
  // the current production_orders.poNo (the SO was edited → pieces renumbered, a
  // trailing space, a case difference), the scan dead-ends at "Not found".
  // Recover it: (a) trim/case-insensitive poNo retry; then (b) resolve via
  // fg_units — the sticker's po equals the UNIT's stored poNo, and fg_units.poId
  // is the stable PO id, so the piece is found even after the poNo string moved.
  // Only loads a LIVE production_order (a purged PO → nothing → honest Not-found
  // → reprint). Additive: runs only after every existing path missed.
  if (poRows.length === 0) {
    poRows =
      (
        await c.var.DB.prepare(
          "SELECT * FROM production_orders WHERE LOWER(TRIM(poNo)) = LOWER(TRIM(?)) LIMIT 5",
        )
          .bind(term)
          .all<PoRowFull>()
      ).results ?? [];
  }
  if (poRows.length === 0) {
    try {
      const fu = await c.var.DB.prepare(
        "SELECT poId FROM fg_units WHERE poNo = ? AND poId IS NOT NULL LIMIT 1",
      )
        .bind(term)
        .first<{ poId: string | null }>();
      if (fu?.poId) {
        poRows =
          (
            await c.var.DB.prepare(
              "SELECT * FROM production_orders WHERE id = ? LIMIT 1",
            )
              .bind(fu.poId)
              .all<PoRowFull>()
          ).results ?? [];
      }
    } catch (e) {
      console.warn("[scan-lookup] fg_units fallback failed:", e);
    }
  }

  if (poRows.length === 0) return c.json({ success: true, data: [] });

  const poIds = poRows.map((p) => p.id);
  const placeholders = poIds.map(() => "?").join(", ");
  let jcSql = `SELECT * FROM job_cards WHERE productionOrderId IN (${placeholders})`;
  const binds: string[] = [...poIds];
  if (deptHint) {
    jcSql += " AND departmentCode = ?";
    binds.push(deptHint);
  }
  const jcRows =
    (await c.var.DB.prepare(jcSql).bind(...binds).all<JcRowFull>()).results ??
    [];

  // Per-piece slots for these JCs so the scan page can pre-check "already
  // done / limit reached" on a per-piece (PACKING) sticker BEFORE the worker
  // taps Complete. BUG-2026-06-08: without this the phone's pre-check is blind
  // (rowToMinimalPO omitted piecePics), so a rescan of a completed piece left
  // Complete enabled and the worker only hit a 409 AFTER tapping.
  const jcIds = jcRows.map((j) => j.id);
  const picsByJcId = new Map<string, ProdPiecePicRow[]>();
  if (jcIds.length > 0) {
    const ph = jcIds.map(() => "?").join(", ");
    const picRows =
      (
        await c.var.DB.prepare(
          `SELECT * FROM piece_pics WHERE jobCardId IN (${ph})`,
        )
          .bind(...jcIds)
          .all<ProdPiecePicRow>()
      ).results ?? [];
    for (const p of picRows) {
      const arr = picsByJcId.get(p.jobCardId);
      if (arr) arr.push(p);
      else picsByJcId.set(p.jobCardId, [p]);
    }
  }

  // Belt-and-suspenders: rowToMinimalPO does per-PO derivations; if any single
  // PO row carries shape the converter doesn't expect, fail the lookup SOFTLY
  // (empty → "Not found") rather than 500 → the scan page's "出错了 / Something
  // went wrong". The exception is logged so a genuinely-broken PO is findable.
  let data: ReturnType<typeof rowToMinimalPO>[];
  try {
    data = poRows.map((po) =>
      rowToMinimalPO(po, jcRows, new Map(), null, null, null, null, null, picsByJcId),
    );
  } catch (e) {
    console.warn("[scan-lookup] response build failed:", e);
    return c.json({ success: true, data: [] });
  }
  return c.json({ success: true, data });
});

// ============================================================
// GET /api/worker/racks
//
// The warehouse rack catalog (Rack 1-20) for the Packing scan page's rack
// dropdown — same source as the dashboard packing schedule (rack_locations),
// exposed to the worker token (the dashboard /api/warehouse is not worker-
// public). Returns each rack + whether it's occupied so the picker can hint.
// ============================================================
app.get("/racks", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const res = await c.var.DB.prepare(
    "SELECT rack, status FROM rack_locations ORDER BY rack",
  ).all<{ rack: string; status: string }>();
  const racks = (res.results ?? []).map((r) => ({
    rack: r.rack,
    occupied: r.status === "OCCUPIED",
  }));
  return c.json({ success: true, data: racks });
});

// ============================================================
// POST /api/worker/packing-rack
// Body: { jobCardId, rackingNumber }
//
// Lets a Packing worker set/update the warehouse rack number from the phone —
// either while completing OR by re-scanning an already-COMPLETED packing card
// (so it is intentionally NOT gated on card status). Writes job_cards.racking-
// Number and mirrors it onto the PO, the same contract as the dashboard rack
// dropdown (PATCH /api/production-orders/:id { jobCardId, rackingNumber }). The
// value is validated against the warehouse rack catalog (rack_locations.rack) —
// reject, don't normalize. Empty string clears the rack.
// ============================================================
app.post("/packing-rack", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const body = await c.req.json().catch(() => ({}));
  const { jobCardId, rackingNumber } = (body || {}) as {
    jobCardId?: string;
    rackingNumber?: string;
  };
  // The validation + writes live in the SHARED helper so this worker path and
  // the PUBLIC packing-sticker scan (routes/public-rack-write.ts) can't drift
  // (same contract as the office dashboard rack dropdown).
  const res = await applyPackingRack(c.var.DB, jobCardId, rackingNumber);
  if (!res.ok) {
    const status = res.code === "NOT_FOUND" ? 404 : 400;
    return c.json({ success: false, error: res.error }, status);
  }
  return c.json({
    success: true,
    data: { jobCardId: res.jobCardId, rackingNumber: res.rackingNumber },
  });
});

// ============================================================
// POST /api/worker/clock
// Body: { action: 'CLOCK_IN' | 'CLOCK_OUT' }
// ============================================================
type DepartmentRow = { id: string; shortName: string };

// Soft punch-geofence. Geo columns are added at runtime (the ensurePendingMigrations
// pattern used elsewhere) so a punch can stamp the worker's location without a
// deploy-time migration step. Additive + nullable + IF NOT EXISTS → a re-run is a
// no-op, and a phone that denies/can't-get location just leaves them null. SOFT:
// location is recorded for review, never blocks the punch.
let _attendanceGeoMig = false;
async function ensureAttendanceGeo(db: D1Database): Promise<void> {
  if (_attendanceGeoMig) return;

  const stmts = [
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockInLat DOUBLE PRECISION",
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockInLng DOUBLE PRECISION",
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockOutLat DOUBLE PRECISION",
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockOutLng DOUBLE PRECISION",
    // Punch selfie (compressed JPEG data URL) — anti-buddy-punching evidence.
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockInPhoto TEXT",
    "ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS clockOutPhoto TEXT",
  ];
  for (const s of stmts) await db.prepare(s).run();
  _attendanceGeoMig = true;
}
// Valid WGS84 coordinate or null (a denied/garbage reading must not be stored).
function parseCoord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180
    ? v
    : null;
}
async function stampPunchGeo(
  db: D1Database,
  recId: string,
  action: "CLOCK_IN" | "CLOCK_OUT",
  lat: number | null,
  lng: number | null,
): Promise<void> {
  if (lat === null || lng === null) return;
  const cols =
    action === "CLOCK_IN"
      ? "clockInLat = ?, clockInLng = ?"
      : "clockOutLat = ?, clockOutLng = ?";
  await db
    .prepare(`UPDATE attendance_records SET ${cols} WHERE id = ?`)
    .bind(lat, lng, recId)
    .run();
}
// Store the punch SELFIE (a client-compressed JPEG data URL) for anti-buddy-
// punching review. Optional — a worker who cancels/denies the camera leaves it
// null and the punch still goes through. Guarded so a junk / oversized payload
// can't bloat the row (≈640px JPEG ⇒ tens of KB; cap well above that).
async function stampPunchPhoto(
  db: D1Database,
  recId: string,
  action: "CLOCK_IN" | "CLOCK_OUT",
  photo: string | null,
): Promise<void> {
  if (!photo || !photo.startsWith("data:image/") || photo.length > 600_000) return;
  const col = action === "CLOCK_IN" ? "clockInPhoto" : "clockOutPhoto";
  await db
    .prepare(`UPDATE attendance_records SET ${col} = ? WHERE id = ?`)
    .bind(photo, recId)
    .run();
}

// ── Forgotten clock-out auto-close ──────────────────────────────────────────
// A worker who clocks IN but never OUT leaves an open punch. Per Wei Siang
// 2026-06-16: once it's past midnight with no clock-out it counts as a forgotten
// punch — that day STILL pays as a NORMAL shift (standard hours, NO overtime, NO
// short-hour dock; a missed punch isn't a real short/long day) and is FLAGGED in
// Attendance so the office sees it. Two triggers close these, sharing this one
// helper so the rule never drifts:
//   1. The worker's NEXT clock-in (self-heal in POST /clock) — but only fires if
//      they actually return the next day.
//   2. The midnight cron (autoCloseStalePunches) — closes them even when the
//      worker is absent the next day.
// Idempotent via the `clockOut IS NULL` guard, so the two can never double-close.
async function autoCloseForgottenPunch(
  db: D1Database,
  row: AttendanceRow,
  payRules: Awaited<ReturnType<typeof loadPayRuleVersions>>,
  workingHoursPerDay: number,
): Promise<void> {
  if (!row.clockIn || row.clockOut) return;
  const rules = toAttendanceRules(
    resolvePayRulesAsOf(payRules, (row.date || "").slice(0, 10)),
  );
  const endMin = rules.endMin;
  const outTime = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
  const stdMin = (workingHoursPerDay || 9) * 60;
  const prodMin = Math.max(0, Math.round(stdMin * 0.85));
  const effPct = stdMin > 0 ? Math.round((prodMin / stdMin) * 100) : 0;
  await db
    .prepare(
      `UPDATE attendance_records
         SET clockOut = ?, workingMinutes = ?, productionTimeMinutes = ?,
             efficiencyPct = ?, overtimeMinutes = 0,
             notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes END
       WHERE id = ? AND clockOut IS NULL`,
    )
    .bind(
      outTime,
      stdMin,
      prodMin,
      effPct,
      "Forgot to punch out — auto-counted as a normal shift",
      row.id,
    )
    .run();

  // BUG-2026-08-01-004 — closing the punch was never enough. Pay reads
  // working_hour_entries, NOT attendance_records: a day with no entries is an
  // ABSENCE and docks a full day (salary ÷ 26). Both auto-close paths used to
  // stop at the UPDATE above, so every forgotten punch-out silently cost the
  // worker a full day — the exact opposite of "auto-counted as a normal shift"
  // (25 worker-days / ~RM2,100 in 2026-07 alone; ANN EMP-004 lost 9 of 9 days).
  // fixedHours = the CONTRACTED shift, so a late/inverted punch can't shrink it
  // and no short-hour dock follows. Never overwrites office-keyed rows (the
  // helper's own gate). Best-effort: a hiccup here must not undo the close.
  try {
    const r = row as AttendanceRow & {
      employee_id?: string;
      department_code?: string;
    };
    await autofillWorkingHoursFromPunch(db, {
      attendanceId: row.id,
      workerId: row.employeeId ?? r.employee_id ?? "",
      date: (row.date || "").slice(0, 10),
      clockIn: row.clockIn ?? "",
      clockOut: outTime,
      homeDeptCode: row.departmentCode ?? r.department_code ?? null,
      fixedHours: stdMin / 60,
    });
  } catch (e) {
    console.warn("[auto-clockout] working-hours auto-fill skipped", row.id, e);
  }
}

// Midnight cron entry: close EVERY worker's prior-day open punch (date < today
// MYT, clocked in, never out) — even workers who don't return the next day, the
// gap the per-clock-in self-heal can't cover. Joins `workers` for each one's
// standard shift length. Best-effort per row so one bad row never aborts the
// batch; returns a small tally for the cron log. Exposed via the CRON_SECRET-
// gated POST /api/internal/auto-clockout in worker.ts (the app entry).
export async function autoCloseStalePunches(
  db: D1Database,
): Promise<{ scanned: number; closed: number }> {
  const today = malaysiaNow().toISOString().slice(0, 10);
  const stale = await db
    .prepare(
      `SELECT a.*, COALESCE(w.workingHoursPerDay, 9) AS whpd
         FROM attendance_records a
         LEFT JOIN workers w ON w.id = a.employeeId
        WHERE a.date < ? AND a.clockIn IS NOT NULL AND a.clockOut IS NULL`,
    )
    .bind(today)
    .all<AttendanceRow & { whpd: number }>();
  const rows = stale.results ?? [];
  let payRules: Awaited<ReturnType<typeof loadPayRuleVersions>> = [];
  try {
    payRules = await loadPayRuleVersions(db);
  } catch {
    payRules = [];
  }
  let closed = 0;
  for (const r of rows) {
    try {
      await autoCloseForgottenPunch(db, r, payRules, Number(r.whpd) || 9);
      closed++;
    } catch (e) {
      console.warn("[auto-clockout] skip row", r.id, e);
    }
  }
  return { scanned: rows.length, closed };
}

app.post("/clock", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  if (action !== "CLOCK_IN" && action !== "CLOCK_OUT") {
    return c.json({ success: false, error: "Invalid action" }, 400);
  }

  // Optional punch location (soft geofence). Absent / denied → null → not stored.
  const lat = parseCoord((body as { lat?: unknown }).lat);
  const lng = parseCoord((body as { lng?: unknown }).lng);
  // Optional punch selfie (anti-buddy-punching). Absent / cancelled → null.
  const photo =
    typeof (body as { photo?: unknown }).photo === "string"
      ? (body as { photo: string }).photo
      : null;
  await ensureAttendanceGeo(c.var.DB);

  // Malaysia local date + HH:MM from ONE instant (so date and time can't split
  // across midnight). UTC fields of the +8h-shifted time = Malaysia wall clock.
  const my = malaysiaNow();
  const date = my.toISOString().slice(0, 10);
  const time = my.toISOString().slice(11, 16);

  const existing = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE employeeId = ? AND date = ?",
  )
    .bind(worker.id, date)
    .first<AttendanceRow>();

  if (action === "CLOCK_IN") {
    // Self-heal a forgotten clock-out: close any PRIOR-day open punch (this
    // worker, date < today, clocked in but never out) at its shift end — 18:00
    // by the day's pay rules — running the SAME auto short-hour dock + Working-
    // Hours autofill a manual clock-out does, so the forgotten day still counts
    // for pay instead of sitting at 0h. The worker then clocks in fresh today
    // (state is per calendar day, so this never blocks today's punch). Wei Siang
    // 2026-06-16. Best-effort — a hiccup must never break the clock-in.
    try {
      const stale = await c.var.DB.prepare(
        "SELECT * FROM attendance_records WHERE employeeId = ? AND date < ? AND clockIn IS NOT NULL AND clockOut IS NULL",
      )
        .bind(worker.id, date)
        .all<AttendanceRow>();
      const staleRows = stale.results ?? [];
      if (staleRows.length > 0) {
        let payRules: Awaited<ReturnType<typeof loadPayRuleVersions>> = [];
        try {
          payRules = await loadPayRuleVersions(c.var.DB);
        } catch {
          payRules = [];
        }
        // Same rule as the midnight cron — close each at shift end, normal
        // hours, flagged. Shared helper so the two paths can never drift.
        for (const s of staleRows) {
          await autoCloseForgottenPunch(
            c.var.DB,
            s,
            payRules,
            worker.workingHoursPerDay || 9,
          );
        }
      }
    } catch (e) {
      console.warn("[worker/clock] prior-day auto clock-out skipped:", e);
    }
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
      await stampPunchGeo(c.var.DB, existing.id, "CLOCK_IN", lat, lng);
      await stampPunchPhoto(c.var.DB, existing.id, "CLOCK_IN", photo);
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
    await stampPunchGeo(c.var.DB, id, "CLOCK_IN", lat, lng);
    await stampPunchPhoto(c.var.DB, id, "CLOCK_IN", photo);
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
    overtimeMinutes = otMinutesAtLeastMinimum(total - standardMinutes);
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
  await stampPunchGeo(c.var.DB, existing.id, "CLOCK_OUT", lat, lng);
  await stampPunchPhoto(c.var.DB, existing.id, "CLOCK_OUT", photo);

  // Auto short-hour dock (real money). Now that we have BOTH a clock-in and a
  // clock-out, apply the shift rules (late past grace / short of 9h) and, if
  // warranted, dock the shortfall — so the owner doesn't have to do it by hand.
  // Heavily guarded inside the helper (no clock-out → skip, finalised month →
  // skip, never overrides a manual dock). Best-effort: a dock hiccup must NEVER
  // fail the punch, and "no dock" is always the safe fallback.
  if (existing.clockIn) {
    // Auto-fill Working Hours from the punch + today's dept scans (owner
    // 2026-06-11): default = the worker's home department; scans re-route
    // stretches of the day; category follows the dept's actual job cards.
    // Never overwrites office-keyed rows; best-effort like the dock.
    //
    // MUST run BEFORE the dock. The dock's "never charge an absent day twice"
    // guard (BUG-2026-08-01-005) reads this day's logged hours — with the old
    // order those rows didn't exist yet, so every live punch-out would look
    // like an absent day and no short-hour dock would ever apply again.
    try {
      // BROKEN PUNCH (owner 2026-08-01, 「前期我们松一点通融点」). A worker who
      // forgot the morning punch and tapped in AND out at knock-off leaves a
      // window with no payable minutes (18:01 in / 18:02 out). The normal path
      // writes nothing for it, so the day logs 0h and counts as a full absence
      // — for someone who was demonstrably at the factory to punch at all.
      // When `brokenPunchCreditsFullDay` is on, credit the contracted shift
      // instead, exactly as a forgotten punch-OUT already is. Flip the rule
      // off from a chosen date (it is effective-dated) to go back to
      // "absence, charged once".
      const brokenIn = hhmmToMinutes(existing.clockIn);
      const brokenOut = hhmmToMinutes(time);
      let credit = 0;
      try {
        const cfg = resolvePayRulesAsOf(await loadPayRuleVersions(c.var.DB), date);
        if (cfg.brokenPunchCreditsFullDay) {
          const broken =
            brokenIn == null ||
            brokenOut == null ||
            brokenOut <= brokenIn ||
            (() => {
              const day = computeAttendanceDay(brokenIn, brokenOut, toAttendanceRules(cfg));
              return day.regularWorkMin <= 0 && day.otMin <= 0;
            })();
          if (broken) credit = worker.workingHoursPerDay || 9;
        }
      } catch {
        /* rules unreadable → no credit, the pre-rule behaviour */
      }
      await autofillWorkingHoursFromPunch(c.var.DB, {
        attendanceId: existing.id,
        workerId: worker.id,
        date,
        clockIn: existing.clockIn,
        clockOut: time,
        homeDeptCode: worker.departmentCode,
        fixedHours: credit || null,
      });
    } catch (e) {
      console.warn("[worker/clock] working-hours auto-fill skipped:", e);
    }
    try {
      await maybeApplyAutoPunchDock(c.var.DB, {
        workerId: worker.id,
        date,
        clockIn: existing.clockIn,
        clockOut: time,
      });
    } catch (e) {
      console.warn("[worker/clock] auto short-hour dock skipped:", e);
    }
  }

  const row = await c.var.DB.prepare(
    "SELECT * FROM attendance_records WHERE id = ?",
  )
    .bind(existing.id)
    .first<AttendanceRow>();
  return c.json({ success: true, data: row });
});

// ============================================================
// POST /api/worker/dept-scan
// Body: { departmentCode } — the worker scanned a department QR ("I am now
// working in <dept>"). Owner 2026-06-11: the day defaults to the worker's
// HOME department; a scan re-routes time to the scanned department from this
// minute until the next scan or punch-out. Requires an OPEN punch (clocked
// in, not yet out) so a stray scan can't create time out of thin air.
// ============================================================
app.post("/dept-scan", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const code = String((body as { departmentCode?: unknown }).departmentCode ?? "")
    .trim()
    .toUpperCase();
  if (!code) {
    return c.json({ success: false, error: "departmentCode required" }, 400);
  }
  // Optional line category (owner v2): production QRs are per-line — Fab
  // Sew·Sofa vs Fab Sew·Bedframe. Anything not in the catalog is dropped to
  // null (dept-only) rather than stored — reject-don't-normalize spirit.
  const rawCat = String((body as { category?: unknown }).category ?? "")
    .trim()
    .toUpperCase();
  const category = ["SOFA", "BEDFRAME", "ACCESSORY"].includes(rawCat)
    ? rawCat
    : null;
  const dept = await c.var.DB.prepare(
    "SELECT code, shortName, name FROM departments WHERE code = ?",
  )
    .bind(code)
    .first<{ code: string; shortName: string | null; name: string | null }>();
  if (!dept) {
    return c.json({ success: false, error: "UNKNOWN_DEPT" }, 404);
  }

  const my = malaysiaNow();
  const date = my.toISOString().slice(0, 10);
  const time = my.toISOString().slice(11, 16);
  const att = await c.var.DB.prepare(
    "SELECT id, clockIn, clockOut FROM attendance_records WHERE employeeId = ? AND date = ?",
  )
    .bind(worker.id, date)
    .first<{ id: string; clockIn: string | null; clockOut: string | null }>();
  if (!att?.clockIn || att.clockOut) {
    // Not punched in (or already punched out) — the scan has no open day to
    // attach to. The phone shows "punch in first".
    return c.json({ success: false, error: "PUNCH_IN_FIRST" }, 400);
  }

  const [hh, mm] = time.split(":").map(Number);
  await recordDeptScan(c.var.DB, {
    workerId: worker.id,
    date,
    departmentCode: dept.code,
    category,
    atMin: hh * 60 + mm,
  });
  return c.json({
    success: true,
    data: {
      departmentCode: dept.code,
      departmentName: dept.shortName || dept.name || dept.code,
      category,
      time,
    },
  });
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

  // Self-apply the perf indices + snapshot tables (migrations 0197/0199 don't
  // auto-replay on deploy — they reach prod via these CREATE … IF NOT EXISTS,
  // memoized per isolate so the warm path is a no-op).
  await ensureWorkerPerfIndices(c.var.DB);
  await ensureWorkerSnapshotTables(c.var.DB);

  // Cache-aside snapshot (lazy recompute-on-READ). The freshness probe takes
  // MAX(updated_at/created_at) across the source tables; any office/floor edit
  // bumps one and the next read recomputes. The snapshot result is byte-
  // identical to the live compute — pure latency win, no behaviour change.
  const histData = await withWorkerSnapshot(
    c.var.DB,
    {
      tableName: "worker_history_snapshot",
      sourceTables: [
        "attendance_records",
        "working_hour_entries",
        "job_cards",
        "piece_pics",
        "worker_nonprod_requests",
        "production_orders",
        "workers",
      ] as const,
      orgId: DEFAULT_ORG_ID,
      cacheKey: `${workerId}:${fromStr}:${toStr}`,
    },
    async () => {

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

  // Approved EXTRA PRODUCTION TIME claims (kind='ADD_PROD') for this worker in
  // range. These add to the production NUMERATOR (totals.productionMinutes) and
  // annotate the matching Completed Products row when linked to a job card.
  // Soft-fails to empty (cold isolate / missing column) → pre-feature numbers.
  let addProdTotalMin = 0;
  const addProdMinByJobCard = new Map<string, number>();
  try {
    await ensureNonprodRequests(c.var.DB);
    const apRes = await c.var.DB.prepare(
      `SELECT COALESCE(approved_hours, hours) AS hours, job_card_id AS jobCardId
         FROM worker_nonprod_requests
        WHERE worker_id = ? AND kind = 'ADD_PROD' AND status = 'APPROVED'
          AND date >= ? AND date <= ?`,
    )
      .bind(workerId, fromStr, toStr)
      .all<{ hours: number | string | null; jobCardId: string | null }>();
    for (const r of apRes.results ?? []) {
      const h = typeof r.hours === "number" ? r.hours : Number(r.hours) || 0;
      const mins = Math.round(h * 60);
      addProdTotalMin += mins;
      const jc = (r.jobCardId ?? "").trim();
      if (jc) addProdMinByJobCard.set(jc, (addProdMinByJobCard.get(jc) ?? 0) + mins);
    }
  } catch {
    addProdTotalMin = 0;
    addProdMinByJobCard.clear();
  }

  const standardMins = hoursPerDay * 60;
  // Late minutes per punch day (owner 2026-06-11: the phone must show "how
  // late that day"). Same effective-dated rules + ceiling the auto-dock uses
  // (raw lateness past grace, ceiled to 15-min blocks via penal handling in
  // computeAttendanceDay — we surface its lateMin, the RAW figure shown
  // everywhere else). Resilient: no versions table → defaults.
  let histPayRules: Awaited<ReturnType<typeof loadPayRuleVersions>> = [];
  try {
    histPayRules = await loadPayRuleVersions(c.var.DB);
  } catch {
    histPayRules = [];
  }
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
      // One OT minimum for the whole system (OT_MIN_MINUTES, owner 2026-07-04:
      // 「OT 要30分鐘才算」). Without it this screen showed a worker 0.02h of
      // overtime on a day payroll pays nothing for.
      overtimeMinutes = otMinutesAtLeastMinimum(wheMins - standardMins);
    }
    let lateMinutes = 0;
    if (r.clockIn) {
      const inMin = hhmmToMinutes(r.clockIn);
      if (inMin != null) {
        const rules = toAttendanceRules(
          resolvePayRulesAsOf(histPayRules, (r.date || "").slice(0, 10)),
        );
        const outMin = r.clockOut ? hhmmToMinutes(r.clockOut) : null;
        // No clock-out yet → judge lateness alone against the shift start.
        const day = computeAttendanceDay(inMin, outMin ?? rules.endMin, rules);
        lateMinutes = day.lateMin;
      }
    }
    return {
      date: r.date,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      workingMinutes,
      productionTimeMinutes: r.productionTimeMinutes,
      efficiencyPct: r.efficiencyPct,
      overtimeMinutes,
      lateMinutes,
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
    // Approved EXTRA PRODUCTION TIME (kind='ADD_PROD') linked to this job card,
    // in minutes. 0 when the worker has no approved extra-time claim for this JC.
    // Surfaced as "+N min approved (extra time)" on the card.
    addProdMinutes: number;
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
      // Per-piece minute base. Normal depts store per-PIECE estMinutes, so each
      // piece row carries jc.estMinutes (summing over the piece rows the worker
      // did = their share of the JC). Merged FAB_CUT cards store the per-SET
      // TOTAL on the JC (not per-piece), so the per-piece base is that total ÷
      // piece count — a worker who did every piece sums to the stored total
      // (credited once), not total × piece count (the 3× over-count this fix
      // removes); a worker who did only some pieces still gets their pro-rata
      // share. Co-pic halving (÷ picCount) then applies per piece as before.
      const perPieceMinutes =
        (jc.departmentCode ?? "") === "FAB_CUT"
          ? (jc.productionTimeMinutes || jc.estMinutes || 0) / Math.max(1, pieces.length)
          : jc.estMinutes || 0;
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
      // Legacy path (pre piece_pics — single-JC PIC tracking).
      // B2 fix (2026-05-11 audit): jc.estMinutes is per-UNIT; the pieces
      // path above implicitly sums across pieces (one row per piece), but
      // the legacy path treats the JC as a single chunk and forgot to
      // multiply by wipQty. Result: a worker on a 6-unit divan JC (10 min
      // per unit, no co-pic) was credited 10 min not 60 → under-payment.
      // Mirror the pieces-path math: jc.estMinutes × wipQty ÷ coPicCount.
      // jcMinutesTotal applies that ×wipQty for normal depts and skips it for
      // FAB_CUT (estMinutes is already the per-SET total there) — keeps this
      // legacy credit consistent with the FAB_CUT pieces-path base above.
      if (jc.pic1Id !== workerId && jc.pic2Id !== workerId) continue;
      const coPicCount = (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
      myMinutes = jcMinutesTotal(jc.estMinutes || 0, jc) / Math.max(1, coPicCount);
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
      addProdMinutes: addProdMinByJobCard.get(jc.id) ?? 0,
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
      overtimeMinutes += otMinutesAtLeastMinimum(wheMins - standardMins);
    } else {
      const row = attRowByDate.get(d);
      workedMinutes += row?.workingMinutes ?? 0;
      overtimeMinutes += row?.overtimeMinutes ?? 0;
    }
  }
  // Numerator = completed WIP standard minutes + approved EXTRA PRODUCTION TIME
  // (kind='ADD_PROD'). The extra-time credit is 0 for a worker with no approved
  // claims → totals.productionMinutes stays byte-identical.
  const productionMinutes =
    completed.reduce((s, r) => s + (r.myMinutes || 0), 0) + addProdTotalMin;

  // efficiencyPct — UNIFIED 2026-06-27 to the CANONICAL formula so the worker's
  // own phone number equals exactly what the office Efficiency Overview /
  // Employee Performance tab shows for the same worker + range.
  //   OLD: productionMinutes / workedMinutes, where workedMinutes was ALL-dept
  //        clock time CAPPED at the standard day (non-prod depts inflated the
  //        denominator, the cap distorted it). Result diverged from the office.
  //   NEW: numerator   = completed-JC production minutes + approved ADD_PROD
  //        denominator = production-dept (departments.isProduction) working
  //                      hours × 60, UNCAPPED. Approved NONPROD hours already
  //                      left the prod dept via the split, so they're excluded.
  // Implemented by reusing computeMonthlyEfficiencyByWorker over [from,to] (the
  // single source of truth for both the Overview and the auto-paid efficiency
  // allowance), then reading this worker's entry — guarantees the numerator
  // FIELD (productionTimeMinutes), the prod-dept denominator and the "—" null
  // rule all match the office byte-for-byte. A worker whose hours are all in
  // production depts and who has no non-prod/ADD_PROD split sees ~the same
  // number as before. Returned as a 1-decimal figure (matching the Overview's
  // toFixed(1)); the phone renders `${efficiencyPct}%` unchanged.
  const effByWorkerRange = await memoizedMonthlyEfficiency(
    c.var.DB,
    fromStr,
    toStr,
  );
  const myEff = effByWorkerRange.get(workerId);
  const efficiencyPct =
    myEff && myEff.pct !== null ? Math.round(myEff.pct * 10) / 10 : 0;

  const totals = {
    days: workedDates.size,
    workedMinutes,
    productionMinutes,
    overtimeMinutes,
    completedCount: completed.length,
    // Extra production time credited to the numerator this period (display).
    addProdMinutes: addProdTotalMin,
    efficiencyPct,
  };

      return {
        range: { from: fromStr, to: toStr },
        daily,
        attendance,
        completed,
        totals,
      };
    },
  );

  return c.json({ success: true, data: histData });
});

// ============================================================
// GET /api/worker/payslips
//
// Returns { current, history }:
//   • current  — a LIVE current-month estimate computed by computeMonthlyLabor
//     (the SAME engine the admin Payroll screen + /api/payslips/projected use),
//     on the worker's THIS-MONTH effective salary (day-weighted if it changed
//     mid-month), their logged Working Hours, OT and absences-through-grace.
//     Never stored; once the admin generates the period's payslip the stored
//     row is the source of truth and `history` carries it.
//   • history  — stored payslips, aliasing payslips.* into the camelCase shape
//     the /worker/pay frontend expects (basicSen, grossSen, netSen, ...).
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
  absentDays?: number | null;
  absenceDeductionSen?: number | null;
  otWeekdayHours?: number | null;
  otSundayHours?: number | null;
  otPhHours?: number | null;
};

app.get("/payslips", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;

  // Self-apply the perf indices + snapshot tables (migrations 0197/0198 don't
  // auto-replay on deploy — memoized per isolate so the warm path is a no-op).
  await ensureWorkerPerfIndices(c.var.DB);
  await ensureWorkerSnapshotTables(c.var.DB);

  // Current-month key for the snapshot. Computed up front so the cache_key is
  // stable for the whole request; the live compute below re-derives the same
  // period from `now`.
  const snapNow = new Date();
  const snapPeriod = `${snapNow.getFullYear()}-${String(snapNow.getMonth() + 1).padStart(2, "0")}`;

  // Cache-aside snapshot (lazy recompute-on-READ). Freshness = MAX across the
  // labor + efficiency inputs (working_hour_entries, payroll_hour_deductions,
  // worker_salary_history, job_cards) plus payslips (a newly-generated stored
  // payslip must surface in `history`). Byte-identical to the live compute.
  const payslipsData = await withWorkerSnapshot(
    c.var.DB,
    {
      tableName: "worker_payslips_snapshot",
      sourceTables: [
        "working_hour_entries",
        "payroll_hour_deductions",
        "worker_salary_history",
        "job_cards",
        "payslips",
        // 2026-07-14 freshness fix: the live current-month estimate reads these
        // too (kv_config public_holidays; workers efficiency allowance/basic;
        // worker_nonprod_requests ADD_PROD minutes) — all trackable, so add them
        // so an edit invalidates the payslip snapshot. (departments +
        // pay_rule_versions also feed it but have no updated_at/created_at column
        // the freshness probe can read → those are wiped explicitly on write.)
        "kv_config",
        "workers",
        "worker_nonprod_requests",
      ] as const,
      orgId: DEFAULT_ORG_ID,
      cacheKey: `${workerId}:${snapPeriod}`,
    },
    async () => {

  const res = await c.var.DB.prepare(
    // absentDays / absenceDeductionSen ride along so a FINISHED month can show
    // the same "why is it this number" breakdown the in-progress month already
    // showed. Without them the worker could see every late minute and absent
    // day for the current month and then, once payroll ran, only a bare Net —
    // which is exactly the moment they most want to check it (owner 2026-08-02:
    // 「他们的迟到、OT、请假等等，全部都可以在 MyPay 那一边呈现出来」).
    `SELECT id, employeeId, period, basicSalarySen, totalOtSen, allowancesSen,
            grossPaySen, netPaySen, epfEmployeeSen, socsoEmployeeSen,
            eisEmployeeSen, pcbSen, absentDays, absenceDeductionSen,
            otWeekdayHours, otSundayHours, otPhHours
       FROM payslips
      WHERE employeeId = ?
      ORDER BY period DESC`,
  )
    .bind(workerId)
    .all<PayslipRow>();

  // Late / short-hour docks are NOT a payslips column — they live in
  // payroll_hour_deductions and are folded into the stored gross. Read them
  // per period and price them with the SAME rate the engine docked at (the
  // contractual day rate over the worker's day SPAN, resolved per period), so
  // the worker's phone and the admin payslip quote one number, not two.
  const lateByPeriod = new Map<string, Array<{ date: string; hours: number }>>();
  const lateSenByPeriod = new Map<string, number>();
  try {
    const dedRes = await c.var.DB.prepare(
      "SELECT date, hours FROM payroll_hour_deductions WHERE workerId = ? ORDER BY date",
    )
      .bind(workerId)
      .all<{ date: string; hours: number }>();
    const wRow = await c.var.DB.prepare(
      "SELECT basicSalarySen, workingDaysPerMonth, workingHoursPerDay FROM workers WHERE id = ?",
    )
      .bind(workerId)
      .first<{ basicSalarySen: number; workingDaysPerMonth: number; workingHoursPerDay: number }>();
    const versions = await loadPayRuleVersions(c.var.DB);
    for (const d of dedRes.results ?? []) {
      const h = Number(d.hours) || 0;
      if (h <= 0 || typeof d.date !== "string") continue;
      const per = d.date.slice(0, 7);
      const arr = lateByPeriod.get(per) ?? [];
      arr.push({ date: d.date, hours: Math.round(h * 100) / 100 });
      lateByPeriod.set(per, arr);
      if (!wRow) continue;
      // Rules as of THAT period — a rule change today must not re-price a
      // month the worker was already paid for.
      const cfg = resolvePayRulesAsOf(versions, `${per}-28`);
      const dayRate = payrollDayRateSen(
        Number(wRow.basicSalarySen) || 0,
        {
          workingDaysPerMonth: Number(wRow.workingDaysPerMonth) || 26,
          calendarDays: 30,
          workingDaysInMonth: 26,
        },
        cfg,
      );
      const hourRate = dayRate / payrollHourDivisor(Number(wRow.workingHoursPerDay) || 0, cfg);
      lateSenByPeriod.set(per, (lateSenByPeriod.get(per) ?? 0) + Math.round(h * hourRate));
    }
  } catch (e) {
    // Best-effort: the money figures above are still correct without it, the
    // breakdown just loses its per-day chips. Logged, never silent.
    console.error("[worker/payslips] late-day detail unavailable:", e);
  }

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
    // The "why is it this number" half.
    absentDays: Number(r.absentDays ?? 0),
    absenceDeductionSen: Number(r.absenceDeductionSen ?? 0),
    otHours:
      (Number(r.otWeekdayHours ?? 0) || 0) +
      (Number(r.otSundayHours ?? 0) || 0) +
      (Number(r.otPhHours ?? 0) || 0),
    lateDays: lateByPeriod.get(r.period) ?? [],
    shortHourDeductionSen: lateSenByPeriod.get(r.period) ?? 0,
  }));

  // Live current-month estimate, computed by the shared labor engine —
  // the SAME engine that drives the admin Payroll screen and production
  // labor cost, so the worker's phone shows exactly what payroll will
  // pay. Never overrides `history`: once the admin generates the period's
  // payslip, the stored row is the source of truth and this is just a
  // preview. (Wei Siang 2026-05-22.)
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthPrefix = `${period}-`;

  // This worker's Working Hours rows for the current month.
  const wheRes = await c.var.DB.prepare(
    `SELECT date, hours FROM working_hour_entries
      WHERE workerId = ? AND date LIKE ?`,
  )
    .bind(workerId, `${monthPrefix}%`)
    .all<{ date: string; hours: number }>();

  // Public holidays — kv_config['public_holidays'], a JSON array of
  // YYYY-MM-DD strings. A holiday is never charged to the worker as an
  // absence (the divisor still stays at workingDaysPerMonth).
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

  // Salary effective for THIS month — day-weighted if it changed mid-month (the
  // "Effective from" feature). SAME source the admin payroll + projected estimate
  // use, so the worker's phone matches what they're actually paid even after a
  // mid-month raise. Resilient: no history table / no rows → current basic salary.
  let salaryHistory: Array<{ effectiveFrom: string; basicSalarySen: number }> = [];
  try {
    const wsh = await c.var.DB.prepare(
      "SELECT basicSalarySen, effectiveFrom FROM worker_salary_history WHERE workerId = ?",
    )
      .bind(workerId)
      .all<{ basicSalarySen: number; effectiveFrom: string }>();
    salaryHistory = (wsh.results ?? []).map((r) => ({
      effectiveFrom: r.effectiveFrom,
      basicSalarySen: Number(r.basicSalarySen) || 0,
    }));
  } catch (e) {
    console.warn("[worker/pay] worker_salary_history read skipped:", e);
  }
  const effectiveSalarySen = effectiveSalarySenForMonth(
    salaryHistory,
    auth.worker.basicSalarySen,
    now.getFullYear(),
    now.getMonth() + 1,
    publicHolidays,
  );

  const dayRows = (wheRes.results ?? []).map((r) => ({
    date: r.date,
    hours: Number(r.hours) || 0,
  }));
  // Current month — count absences only through the data-entry grace cutoff
  // (2 working days back), so days that haven't happened yet AND the most
  // recent not-yet-keyed days aren't charged as absences. Matches payroll.
  // Effective-dated grace — same source the office payroll uses.
  const workerPayRules = await loadPayRuleVersions(c.var.DB);
  const absenceThroughDay = absenceCutoffDay(
    now.getFullYear(),
    now.getMonth() + 1,
    now,
    resolvePayRulesAsOf(workerPayRules, now.toISOString().slice(0, 10))
      .absenceGraceWorkingDays,
    publicHolidays,
  );

  // Owner-flagged unworked-hour docks for the month (the under-recorded review /
  // late-short deductions). The worker's estimate must reflect them too, else the
  // phone shows MORE than they're actually paid. Resilient: if the table isn't
  // there yet → no docks. Same source the admin payroll uses.
  let shortHourDeductionHours = 0;
  // Per-day breakdown of the docks so My Pay can drill the late/short figure down
  // to the specific days (date + hours docked), mirroring the Absent / OT chips.
  const lateDays: Array<{ date: string; hours: number; note: string }> = [];
  try {
    const dedRes = await c.var.DB.prepare(
      "SELECT date, hours, note FROM payroll_hour_deductions WHERE workerId = ? AND date LIKE ? ORDER BY date",
    )
      .bind(workerId, `${monthPrefix}%`)
      .all<{ date: string; hours: number; note: string | null }>();
    for (const r of dedRes.results ?? []) {
      const h = Number(r.hours) || 0;
      shortHourDeductionHours += h;
      if (h > 0) {
        lateDays.push({ date: r.date, hours: Math.round(h * 100) / 100, note: r.note ?? "" });
      }
    }
  } catch (e) {
    console.warn("[worker/pay] payroll_hour_deductions read skipped:", e);
  }

  const labor = computeMonthlyLabor({
    worker: {
      basicSalarySen: effectiveSalarySen,
      workingDaysPerMonth: auth.worker.workingDaysPerMonth,
      workingHoursPerDay: auth.worker.workingHoursPerDay,
      otMultiplier: auth.worker.otMultiplier,
    },
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    days: dayRows,
    publicHolidays,
    absenceThroughDay,
    shortHourDeductionHours,
    // Effective-dated pay rules — same source the office payroll uses, so the
    // phone estimate can never disagree with the payslip.
    payRuleVersions: workerPayRules,
  });

  // WHICH days were absent / had OT — derived from the SAME inputs the engine
  // just used, so the dates line up with the counts. Display-only (no amounts);
  // lets My Pay drill the Absent / OT figures down to the specific dates.
  const dayDetail = computeAttendanceDayDetail({
    worker: { workingHoursPerDay: auth.worker.workingHoursPerDay },
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    days: dayRows,
    publicHolidays,
    absenceThroughDay,
  });

  // Efficiency allowance — a flat bonus when the worker's MONTH-CUMULATIVE
  // efficiency (the same figure the admin Efficiency Overview shows) reaches
  // their configured threshold. Pure non-statutory bonus: added to gross only,
  // never touches EPF / SOCSO / EIS / PCB. For the in-progress month this is
  // the to-date estimate (only elapsed cards + keyed hours exist yet).
  const { start: effStart, end: effEnd } = monthBounds(period);
  const effByWorker = await computeMonthlyEfficiencyByWorker(
    c.var.DB,
    effStart,
    effEnd,
  );
  const effCfg = await c.var.DB.prepare(
    "SELECT efficiencyAllowanceSen, efficiencyThresholdPct FROM workers WHERE id = ?",
  )
    .bind(workerId)
    .first<{
      efficiencyAllowanceSen: number | null;
      efficiencyThresholdPct: number | null;
    }>();
  const efficiencyAllowanceSen = resolveEfficiencyAllowanceSen(
    effByWorker.get(workerId),
    effCfg?.efficiencyAllowanceSen,
    effCfg?.efficiencyThresholdPct,
  );

  // The stored payslip for this period, if the office has generated one.
  // DRAFT (or none) → the numbers above are an estimate.
  let payslipStatus: "NONE" | "DRAFT" | "APPROVED" | "PAID" = "NONE";
  try {
    const ps = await c.var.DB.prepare(
      "SELECT status FROM payslips WHERE employeeId = ? AND period = ?",
    )
      .bind(workerId, period)
      .first<{ status: string }>();
    if (ps?.status === "APPROVED" || ps?.status === "PAID" || ps?.status === "DRAFT") {
      payslipStatus = ps.status;
    }
  } catch {
    /* unreadable → treated as not finalised, which is the safe direction */
  }

      return {
        current: {
          period,
          workedDays: labor.daysWorked,
          absentDays: labor.payroll.absentDays,
          otMinutes: Math.round(labor.otHours * 60),
          fullSalarySen: labor.payroll.fullSalarySen,
          absenceDeductionSen: labor.payroll.absenceDeductionSen,
          shortHourDeductionSen: labor.payroll.shortHourDeductionSen,
          basicEarnedSen: labor.payroll.basicEarnedSen,
          otSen: labor.payroll.otPaySen,
          efficiencyAllowanceSen,
          estimatedGrossSen: labor.payroll.grossSen + efficiencyAllowanceSen,
          // Per-day detail so My Pay can show WHICH days were absent / had OT /
          // were late-or-short (each docked day + the hours docked).
          absentDates: dayDetail.absentDates,
          otDays: dayDetail.otDays,
          lateDays,
          // Whether the office has FINALISED this month. Everything above is a
          // live estimate that moves as attendance comes in; only an approved
          // month is a document the worker can keep (owner 2026-08-01: 只有
          // approved 才能 print). The phone hides Save-as-PDF until then, so a
          // mid-month figure can never be mistaken for the final one.
          payslipStatus,
        },
        history,
      };
    },
  );

  return c.json({ success: true, data: payslipsData });
});

/**
 * Absent dates, OT days and docked days for ONE worker-month.
 *
 * Same inputs the payroll engine uses, so the dates on the payslip line up with
 * the counts on it. Kept separate from the live /payslips estimate because that
 * one is scoped to the CURRENT month and this must work for any finalised past
 * month the worker opens.
 */
async function buildWorkerDayDetail(
  db: D1Database,
  period: string,
  workerId: string,
): Promise<{
  dayDetail: { absentDates: string[]; otDays: Array<{ date: string; hours: number }> };
  lateDays: Array<{ date: string; hours: number }>;
  shortHourDeductionSen: number;
}> {
  const [yy, mm] = period.split("-").map(Number);
  const w = await db
    .prepare("SELECT workingHoursPerDay, basicSalarySen, workingDaysPerMonth FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ workingHoursPerDay: number | null; basicSalarySen: number | null; workingDaysPerMonth: number | null }>();
  const hoursPerDay = Number(w?.workingHoursPerDay) || 9;

  const heRes = await db
    .prepare("SELECT date, hours FROM working_hour_entries WHERE workerId = ? AND date LIKE ?")
    .bind(workerId, `${period}-%`)
    .all<{ date: string; hours: number }>();
  const byDate = new Map<string, number>();
  for (const r of heRes.results ?? []) {
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + (Number(r.hours) || 0));
  }
  const days = [...byDate.entries()].map(([date, hours]) => ({ date, hours }));

  const phRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  try {
    for (const d of JSON.parse(phRow?.value ?? "[]")) {
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) publicHolidays.add(d);
    }
  } catch { /* malformed — no holidays */ }

  const payRules = await loadPayRuleVersions(db).catch(() => []);
  const cfg = resolvePayRulesAsOf(payRules, `${period}-28`);
  // A FINALISED month is whole — count absences through its last day, not
  // through today's grace cutoff, or a past payslip would under-report them.
  const lastDay = new Date(yy, mm, 0).getDate();
  const dayDetail = computeAttendanceDayDetail({
    worker: { workingHoursPerDay: hoursPerDay },
    year: yy,
    month: mm,
    days,
    publicHolidays,
    absenceThroughDay: lastDay,
  });

  const dedRes = await db
    .prepare("SELECT date, hours FROM payroll_hour_deductions WHERE workerId = ? AND date LIKE ? ORDER BY date")
    .bind(workerId, `${period}-%`)
    .all<{ date: string; hours: number }>();
  const dayRate = payrollDayRateSen(
    Number(w?.basicSalarySen) || 0,
    {
      workingDaysPerMonth: Number(w?.workingDaysPerMonth) || 26,
      calendarDays: lastDay,
      workingDaysInMonth: 26,
    },
    cfg,
  );
  const hourRate = dayRate / payrollHourDivisor(hoursPerDay, cfg);
  const lateDays: Array<{ date: string; hours: number }> = [];
  let shortHourDeductionSen = 0;
  for (const d of dedRes.results ?? []) {
    const h = Number(d.hours) || 0;
    if (h <= 0) continue;
    lateDays.push({ date: d.date, hours: Math.round(h * 100) / 100 });
    shortHourDeductionSen += Math.round(h * hourRate);
  }
  return { dayDetail, lateDays, shortHourDeductionSen };
}

// ============================================================
// GET /api/worker/payslip/:period — the worker's OWN payslip, as data.
//
// The phone renders it with the SAME generatePayslipHTML the office prints, so
// there is one document and not a second one that drifts. Returning data rather
// than server-rendered HTML is what keeps that true.
//
// Gated on APPROVED/PAID (owner 2026-08-01: 只有 approved 才能 print). Until the
// office finalises a month its figures move as attendance arrives, and a worker
// holding a PDF that later changed is the argument the whole screen exists to
// prevent. Scoped to the caller — the period is the only parameter, the worker
// comes from their session, so one worker can never fetch another's payslip.
// ============================================================
app.get("/payslip/:period", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const workerId = auth.worker.id;
  const period = c.req.param("period");
  if (!/^\d{4}-\d{2}$/.test(period ?? "")) {
    return c.json({ success: false, error: "Period must be YYYY-MM" }, 400);
  }

  const row = await c.var.DB.prepare(
    "SELECT * FROM payslips WHERE employeeId = ? AND period = ?",
  )
    .bind(workerId, period)
    .first<Record<string, unknown>>();
  if (!row) {
    return c.json(
      { success: false, error: "This month's payslip has not been issued yet." },
      404,
    );
  }
  const status = String(row.status ?? "");
  if (status !== "APPROVED" && status !== "PAID") {
    return c.json(
      { success: false, error: "This month is still being prepared. It is not final yet." },
      409,
    );
  }

  // Day detail — the payslip's whole job is to show WHICH days, so a document
  // without it would answer nothing.
  let dayDetail: { absentDates: string[]; otDays: Array<{ date: string; hours: number }> } = {
    absentDates: [],
    otDays: [],
  };
  const lateDays: Array<{ date: string; hours: number }> = [];
  let shortHourDeductionSen = 0;
  try {
    const detail = await buildWorkerDayDetail(c.var.DB, period, workerId);
    dayDetail = detail.dayDetail;
    lateDays.push(...detail.lateDays);
    shortHourDeductionSen = detail.shortHourDeductionSen;
  } catch (e) {
    console.warn("[worker/payslip] day detail skipped:", e);
  }

  const num = (k: string) => Number(row[k] ?? 0) || 0;
  return c.json({
    success: true,
    data: {
      id: String(row.id ?? ""),
      employeeId: workerId,
      employeeName: String(row.employeeName ?? auth.worker.name ?? ""),
      employeeNo: String(row.employeeNo ?? auth.worker.empNo ?? ""),
      departmentCode: String(row.departmentCode ?? ""),
      period,
      basicSalary: num("basicSalarySen"),
      workingDays: num("workingDays"),
      absentDays: num("absentDays"),
      absenceDeductionSen: num("absenceDeductionSen"),
      shortHourDeductionSen,
      otWeekdayHours: num("otWeekdayHours"),
      otSundayHours: num("otSundayHours"),
      otPHHours: num("otPhHours"),
      hourlyRate: num("hourlyRateSen"),
      otWeekdayAmount: num("otWeekdayAmtSen"),
      otSundayAmount: num("otSundayAmtSen"),
      otPHAmount: num("otPhAmtSen"),
      totalOT: num("totalOtSen"),
      allowances: num("allowancesSen"),
      grossPay: num("grossPaySen"),
      epfEmployee: num("epfEmployeeSen"),
      epfEmployer: num("epfEmployerSen"),
      socsoEmployee: num("socsoEmployeeSen"),
      socsoEmployer: num("socsoEmployerSen"),
      eisEmployee: num("eisEmployeeSen"),
      eisEmployer: num("eisEmployerSen"),
      pcb: num("pcbSen"),
      totalDeductions: num("totalDeductionsSen"),
      netPay: num("netPaySen"),
      bankAccount: String(row.bankAccount ?? ""),
      paymentMethod: String(row.paymentMethod ?? "TRANSFER"),
      bankName: String(row.bankName ?? ""),
      status,
      absentDates: dayDetail.absentDates,
      otDays: dayDetail.otDays,
      lateDays,
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
// Non-production hours APPLY + APPROVE (additive, owner 2026-06-26).
//
// A worker who spent part of a day on NON-production work (R&D / repair /
// warehouse / maintenance / shortfall) produces no Production Time, so their
// efficiency looks unfairly low. They APPLY here for "X hours in <non-prod
// dept> on <date>"; an admin APPROVES from the Working Hours screen, which
// writes a normal working_hour_entries row for that non-prod dept. Because the
// efficiency denominator counts ONLY isProduction departments (see
// efficiency-allowance.ts), those hours are excluded from the denominator →
// efficiency rises, with ZERO formula change.
//
// Runtime self-apply: the table reaches prod via this CREATE-IF-NOT-EXISTS
// (migrations don't auto-replay on deploy). Awaited before the first read/write.
// ============================================================
let _nonprodReqMig = false;
export async function ensureNonprodRequests(db: D1Database): Promise<void> {
  if (_nonprodReqMig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS worker_nonprod_requests (
         id TEXT PRIMARY KEY,
         worker_id TEXT NOT NULL,
         date TEXT NOT NULL,
         department_code TEXT NOT NULL,
         hours DOUBLE PRECISION NOT NULL,
         note TEXT,
         status TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         decided_at TEXT,
         decided_by TEXT,
         entry_id TEXT
       )`,
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_worker_nonprod_requests_worker ON worker_nonprod_requests(worker_id, date DESC)",
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_worker_nonprod_requests_status ON worker_nonprod_requests(status, created_at DESC)",
    )
    .run();
  // Time-adjustment extension (migration 0196, owner 2026-06-26). Additive:
  //   kind        — 'NONPROD' (existing, default) | 'ADD_PROD' (extra production time)
  //   job_card_id — optional WIP/job ref for an ADD_PROD claim
  // Pre-existing 0110 rows default kind='NONPROD' / job_card_id=NULL, so their
  // behaviour is byte-identical. snake_case = no column-rename-map entry.
  await db
    .prepare(
      "ALTER TABLE worker_nonprod_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'NONPROD'",
    )
    .run();
  await db
    .prepare(
      "ALTER TABLE worker_nonprod_requests ADD COLUMN IF NOT EXISTS job_card_id TEXT",
    )
    .run();
  // Reject-with-reason + partial-approve (owner 2026-07-04). Additive:
  //   reject_reason  — required note the office gives when REJECTing; shown
  //                    back to the worker on their portal so they know why.
  //   approved_hours — the amount actually approved (may be LESS than the
  //                    requested `hours`, e.g. asked 1h20m, approved 1h).
  //                    NULL for legacy / not-yet-approved rows → full `hours`.
  // snake_case = no column-rename-map entry needed.
  await db
    .prepare(
      "ALTER TABLE worker_nonprod_requests ADD COLUMN IF NOT EXISTS reject_reason TEXT",
    )
    .run();
  await db
    .prepare(
      "ALTER TABLE worker_nonprod_requests ADD COLUMN IF NOT EXISTS approved_hours DOUBLE PRECISION",
    )
    .run();
  _nonprodReqMig = true;
}

type NonprodRequestRow = {
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

// Dual-key the snake_case row (the db-pg toCamel transform also exposes camelCase
// aliases; reading both ways is the safe pattern for this codebase).
function rowToNonprodRequest(r: NonprodRequestRow & Record<string, unknown>) {
  const num = (a: unknown, b: unknown) => {
    const v = a ?? b;
    return typeof v === "number" ? v : Number(v) || 0;
  };
  const str = (a: unknown, b: unknown) => {
    const v = a ?? b;
    return typeof v === "string" ? v : "";
  };
  // kind defaults to 'NONPROD' so a row written before the column existed (or
  // any legacy 0110 row) reads as non-production — byte-identical behaviour.
  const kindRaw = str(r.kind, r.kind);
  return {
    id: str(r.id, r.id),
    workerId: str(r.workerId, r.worker_id),
    date: str(r.date, r.date),
    departmentCode: str(r.departmentCode, r.department_code),
    hours: num(r.hours, r.hours),
    note: str(r.note, r.note),
    status: str(r.status, r.status),
    createdAt: str(r.createdAt, r.created_at),
    decidedAt: str(r.decidedAt, r.decided_at),
    decidedBy: str(r.decidedBy, r.decided_by),
    kind: kindRaw === "ADD_PROD" ? "ADD_PROD" : "NONPROD",
    jobCardId: str(r.jobCardId, r.job_card_id),
    rejectReason: str(r.rejectReason, r.reject_reason),
    approvedHours: (() => {
      const v = r.approvedHours ?? r.approved_hours;
      return v === null || v === undefined || v === "" ? null : Number(v);
    })(),
  };
}

// ============================================================
// GET /api/worker/nonprod-departments
//
// The NON-production departments the worker may apply hours against (only
// these are selectable — a production dept would be counted in the efficiency
// denominator and defeat the whole point). Source: departments.isProduction.
// ============================================================
app.get("/nonprod-departments", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const res = await c.var.DB.prepare(
    "SELECT code, name, shortName, isProduction, sequence FROM departments ORDER BY sequence",
  ).all<{
    code: string;
    name: string | null;
    shortName: string | null;
    isProduction: number | boolean | null;
    sequence: number | null;
  }>();
  const data = (res.results ?? [])
    .filter((d) => !d.isProduction)
    .map((d) => ({
      code: d.code,
      name: d.shortName || d.name || d.code,
    }));
  return c.json({ success: true, data });
});

// ============================================================
// GET /api/worker/production-departments
//
// The PRODUCTION departments a worker may claim EXTRA PRODUCTION TIME against
// (kind = 'ADD_PROD'). Mirror of /nonprod-departments but isProduction=true.
// Approved ADD_PROD hours are added to the efficiency NUMERATOR (not the
// denominator), so only production depts are selectable here.
// ============================================================
app.get("/production-departments", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const res = await c.var.DB.prepare(
    "SELECT code, name, shortName, isProduction, sequence FROM departments ORDER BY sequence",
  ).all<{
    code: string;
    name: string | null;
    shortName: string | null;
    isProduction: number | boolean | null;
    sequence: number | null;
  }>();
  const data = (res.results ?? [])
    .filter((d) => !!d.isProduction)
    .map((d) => ({
      code: d.code,
      name: d.shortName || d.name || d.code,
    }));
  return c.json({ success: true, data });
});

// ============================================================
// GET /api/worker/nonprod-requests — my non-production hour requests
// ============================================================
app.get("/nonprod-requests", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { workerId } = auth;
  await ensureNonprodRequests(c.var.DB);
  const res = await c.var.DB.prepare(
    "SELECT * FROM worker_nonprod_requests WHERE worker_id = ? ORDER BY created_at DESC LIMIT 30",
  )
    .bind(workerId)
    .all<NonprodRequestRow>();
  const data = (res.results ?? []).map((r) =>
    rowToNonprodRequest(r as NonprodRequestRow & Record<string, unknown>),
  );
  return c.json({ success: true, data });
});

// ============================================================
// POST /api/worker/nonprod-requests
// Body: { date, departmentCode, hours, note?, kind?, jobCardId? }
//   kind = 'NONPROD' (default, existing) — only a NON-production dept;
//          approved hours land in a non-prod working_hour_entries row, which
//          the efficiency denominator EXCLUDES (protects efficiency).
//   kind = 'ADD_PROD' — only a PRODUCTION dept; approved hours are added to the
//          efficiency NUMERATOR (extra production output), jobCardId optional.
// Creates a PENDING request. Validation mirrors the admin approve path:
// a sane date, 0 < hours <= 24, and a dept matching the chosen kind.
// ============================================================
app.post("/nonprod-requests", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  await ensureNonprodRequests(c.var.DB);
  const body = await c.req.json().catch(() => ({}));
  const date = String((body as { date?: unknown }).date ?? "").slice(0, 10);
  const departmentCode = String(
    (body as { departmentCode?: unknown }).departmentCode ?? "",
  )
    .trim()
    .toUpperCase();
  const hours = Number((body as { hours?: unknown }).hours);
  const note = String((body as { note?: unknown }).note ?? "").slice(0, 500);
  // kind defaults to NONPROD (existing behaviour). Anything other than the
  // explicit ADD_PROD token reject-normalises to NONPROD — old clients that
  // never send `kind` keep working exactly as before.
  const kind =
    String((body as { kind?: unknown }).kind ?? "")
      .trim()
      .toUpperCase() === "ADD_PROD"
      ? "ADD_PROD"
      : "NONPROD";
  // jobCardId only meaningful for ADD_PROD (optional WIP/job reference).
  const jobCardId =
    kind === "ADD_PROD"
      ? String((body as { jobCardId?: unknown }).jobCardId ?? "").trim() || null
      : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ success: false, error: "A valid date is required" }, 400);
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return c.json(
      { success: false, error: "Hours must be between 0 and 24" },
      400,
    );
  }
  if (!departmentCode) {
    return c.json({ success: false, error: "Department is required" }, 400);
  }
  // Reject (don't normalize) a dept that doesn't match the chosen kind:
  //   NONPROD  → must be a NON-production dept (denominator-excluded)
  //   ADD_PROD → must be a PRODUCTION dept (numerator credit)
  const dept = await c.var.DB.prepare(
    "SELECT code, isProduction FROM departments WHERE code = ?",
  )
    .bind(departmentCode)
    .first<{ code: string; isProduction: number | boolean | null }>();
  if (!dept) {
    return c.json({ success: false, error: "Unknown department" }, 400);
  }
  if (kind === "ADD_PROD") {
    if (!dept.isProduction) {
      return c.json(
        {
          success: false,
          error: "Extra production time needs a production department",
        },
        400,
      );
    }
  } else if (dept.isProduction) {
    return c.json(
      {
        success: false,
        error: "Only non-production departments can be applied for",
      },
      400,
    );
  }

  const id = genId("npr");
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO worker_nonprod_requests
       (id, worker_id, date, department_code, hours, note, status, created_at, kind, job_card_id)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
  )
    .bind(id, worker.id, date, departmentCode, hours, note, now, kind, jobCardId)
    .run();
  const row = await c.var.DB.prepare(
    "SELECT * FROM worker_nonprod_requests WHERE id = ?",
  )
    .bind(id)
    .first<NonprodRequestRow>();
  return c.json(
    {
      success: true,
      data: row
        ? rowToNonprodRequest(row as NonprodRequestRow & Record<string, unknown>)
        : { id },
    },
    201,
  );
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
  // Scope categories to whatever the leader is responsible for. Empty list
  // means "no filter" — show both SOFA and BEDFRAME. Wei Siang 2026-05-10.
  const ALL_CATEGORIES: Array<"SOFA" | "BEDFRAME"> = ["SOFA", "BEDFRAME"];
  const leaderCats = (() => {
    const raw = (worker as { categories?: string | string[] | null }).categories;
    if (Array.isArray(raw)) {
      const cleaned = raw.filter(
        (x): x is "SOFA" | "BEDFRAME" => x === "SOFA" || x === "BEDFRAME",
      );
      return cleaned.length > 0 ? cleaned : null;
    }
    if (typeof raw === "string" && raw.length > 0) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const cleaned = arr.filter(
            (x): x is "SOFA" | "BEDFRAME" => x === "SOFA" || x === "BEDFRAME",
          );
          return cleaned.length > 0 ? cleaned : null;
        }
      } catch {
        /* malformed → no filter */
      }
    }
    return null;
  })();
  const CATEGORIES: Array<"SOFA" | "BEDFRAME"> = leaderCats ?? ALL_CATEGORIES;

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
              completedDate, estMinutes, actualMinutes, wipQty
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
        wipQty: number | null;
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
      // B3 fix (2026-05-11 audit): both estMinutes and actualMinutes are
      // per-UNIT (import-completion.ts:538 sets actualMinutes ← per-unit
      // value); multiply by wipQty for the JC TOTAL. Without this, a
      // 6-unit sofa Fab Cut merged JC at 30 min/piece showed 30 min of
      // cell production instead of 180. jcMinutesTotal applies that ×wipQty
      // for normal depts and skips it for the merged FAB_CUT card (whose
      // estMinutes is ALREADY the per-SET total — ×wipQty would 3× it).
      const mins = jcMinutesTotal(jc.actualMinutes ?? jc.estMinutes ?? 0, jc);
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

// ============================================================
// GET /api/worker/department-performance
//        ?from=YYYY-MM-DD&to=YYYY-MM-DD
//        &departmentCode=FAB_CUT&category=SOFA
//
// Operator Leader's full Department Performance view — same shape as the
// admin /api/department-performance endpoint, but auth is X-Worker-Token
// and scope is locked to the leader's own departments + categories.
// Powers the /worker/team mobile page.
//
// Authorization: only Operator Leaders get real data. Non-leaders → 200 OK
// with `{ isLeader: false, daily: [], totals: {…zero} }` so the frontend
// can decide. The Team tab is hidden for non-leaders, but defense in depth.
//
// Filter clamping: ?departmentCode and ?category are intersected with the
// leader's scope. Anything outside the scope is treated as "no filter" so
// results stay scoped to the leader's full set instead of leaking other
// teams' data.
//
// Aggregator logic (JC dedup + per-worker pro-rate) mirrors
// src/api/routes/department-performance.ts:80-452. Inlined here on purpose:
// the admin endpoint stays untouched, and the SQL diverges (`IN (...)` for
// the leader's multi-dept scope vs `= ?` for the admin single-filter).
// ============================================================
type DeptPerfWheRow = {
  workerId: string;
  date: string;
  departmentCode: string;
  category: string | null;
  hours: number | string | null;
};
type DeptPerfPoMetaRow = {
  id: string;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  itemCategory: string | null;
};

app.get("/department-performance", async (c) => {
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

  const isLeader = (worker.position ?? "") === "Operator Leader";
  if (!isLeader) {
    return c.json({
      success: true,
      data: {
        isLeader: false,
        range: { from: fromStr, to: toStr },
        departmentCode: null,
        category: null,
        availableDepartments: [],
        availableCategories: [],
        totals: {
          workingMinutes: 0,
          productionMinutes: 0,
          productionWorkingMinutes: 0,
          nonProductionWorkingMinutes: 0,
          efficiencyPct: 0,
          workerCount: 0,
        },
        daily: [],
      },
    });
  }

  const leaderDepts = parseWorkerDepartmentCodes(
    worker.departmentCodes,
    worker.departmentCode,
  );

  // Leader's category restriction — same parse as team-stats above.
  const leaderCats: Array<"SOFA" | "BEDFRAME"> | null = (() => {
    const raw = (worker as { categories?: string | string[] | null })
      .categories;
    if (Array.isArray(raw)) {
      const cleaned = raw.filter(
        (x): x is "SOFA" | "BEDFRAME" => x === "SOFA" || x === "BEDFRAME",
      );
      return cleaned.length > 0 ? cleaned : null;
    }
    if (typeof raw === "string" && raw.length > 0) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const cleaned = arr.filter(
            (x): x is "SOFA" | "BEDFRAME" => x === "SOFA" || x === "BEDFRAME",
          );
          return cleaned.length > 0 ? cleaned : null;
        }
      } catch {
        /* malformed → no restriction */
      }
    }
    return null;
  })();
  const allowedCats: Array<"SOFA" | "BEDFRAME"> = leaderCats ?? [
    "SOFA",
    "BEDFRAME",
  ];

  // Filter clamping. Out-of-scope inputs fall back to "no filter" so the
  // result stays scoped to the leader's full set rather than leaking.
  const departmentCodeQ = (c.req.query("departmentCode") || "").trim();
  const departmentCode =
    departmentCodeQ.length > 0 && leaderDepts.includes(departmentCodeQ)
      ? departmentCodeQ
      : null;

  const categoryQRaw = (c.req.query("category") || "").trim().toUpperCase();
  const category =
    (categoryQRaw === "SOFA" || categoryQRaw === "BEDFRAME") &&
    allowedCats.includes(categoryQRaw as "SOFA" | "BEDFRAME")
      ? (categoryQRaw as "SOFA" | "BEDFRAME")
      : null;

  const activeDepts = departmentCode ? [departmentCode] : leaderDepts;
  const activeCats: Array<"SOFA" | "BEDFRAME"> = category
    ? [category]
    : allowedCats;

  // Empty leader scope → empty result without hitting the DB.
  if (activeDepts.length === 0 || activeCats.length === 0) {
    return c.json({
      success: true,
      data: {
        isLeader: true,
        range: { from: fromStr, to: toStr },
        departmentCode,
        category,
        availableDepartments: leaderDepts,
        availableCategories: allowedCats,
        totals: {
          workingMinutes: 0,
          productionMinutes: 0,
          productionWorkingMinutes: 0,
          nonProductionWorkingMinutes: 0,
          efficiencyPct: 0,
          workerCount: 0,
        },
        daily: [],
      },
    });
  }

  // ---- Per-date accumulators (same shape as the admin endpoint).
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

  const workerIds = new Set<string>();

  // ---- Production-dept lookup: needed to split totals.workingMinutes into
  // production vs non-production for the KPI subtitle on /worker/team. Same
  // source-of-truth (departments.isProduction) the desktop /employees page
  // uses — Warehousing / Repair / Maintenance / Production Shortfall fall
  // outside the production set and so don't dilute Avg Efficiency's denom.
  const productionDeptCodes = new Set<string>();
  {
    const deptPh = activeDepts.map(() => "?").join(",");
    const r = await c.var.DB.prepare(
      `SELECT code, isProduction FROM departments WHERE code IN (${deptPh})`,
    )
      .bind(...activeDepts)
      .all<{ code: string; isProduction: number }>();
    for (const row of r.results ?? []) {
      if (row.isProduction) productionDeptCodes.add(row.code);
    }
  }
  let totalProductionWorkingMinutes = 0;
  let totalNonProductionWorkingMinutes = 0;

  // ---- Working minutes from working_hour_entries.
  {
    const deptPh = activeDepts.map(() => "?").join(",");
    const catPh = activeCats.map(() => "?").join(",");
    const sql = `SELECT workerId, date, departmentCode, category, hours
                   FROM working_hour_entries
                  WHERE date >= ? AND date <= ?
                    AND departmentCode IN (${deptPh})
                    AND category IN (${catPh})`;
    const wheRes = await c.var.DB.prepare(sql)
      .bind(fromStr, toStr, ...activeDepts, ...activeCats)
      .all<DeptPerfWheRow>();
    for (const r of wheRes.results ?? []) {
      const mins = Math.round((Number(r.hours) || 0) * 60);
      const day = ensure(r.date);
      day.workingMinutes += mins;
      if (productionDeptCodes.has(r.departmentCode)) {
        totalProductionWorkingMinutes += mins;
      } else {
        totalNonProductionWorkingMinutes += mins;
      }
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

  // ---- Production minutes: completed/transferred JCs in [from, to], scoped
  // to leader depts. Category filter applied post-PO-join. Dedup per JC.
  {
    const deptPh = activeDepts.map(() => "?").join(",");
    const jcSql = `SELECT id, productionOrderId, departmentCode, pic1Id, pic2Id,
                          completedDate, estMinutes, actualMinutes, wipLabel,
                          wipQty
                     FROM job_cards
                    WHERE status IN ('COMPLETED','TRANSFERRED')
                      AND completedDate >= ? AND completedDate <= ?
                      AND departmentCode IN (${deptPh})`;
    const jcRes = await c.var.DB.prepare(jcSql)
      .bind(fromStr, toStr, ...activeDepts)
      .all<JobCardRow>();
    const candidateJcs = jcRes.results ?? [];

    const poIds = Array.from(
      new Set(
        candidateJcs
          .map((j) => j.productionOrderId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    const poMetaById = new Map<string, DeptPerfPoMetaRow>();
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT id, poNo, productCode, productName, sizeLabel, itemCategory
           FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...poIds)
        .all<DeptPerfPoMetaRow>();
      for (const row of r.results ?? []) {
        poMetaById.set(row.id, row);
      }
    }

    const allowedCatSet = new Set<string>(activeCats);
    const keptJcs = candidateJcs.filter((jc) => {
      if (!jc.completedDate) return false;
      const cat = poMetaById.get(jc.productionOrderId)?.itemCategory ?? null;
      return cat !== null && allowedCatSet.has(cat);
    });

    let allPics: PiecePicRow[] = [];
    if (keptJcs.length > 0) {
      const ids = keptJcs.map((j) => j.id);
      const ph = ids.map(() => "?").join(",");
      const r = await c.var.DB.prepare(
        `SELECT jobCardId, pieceNo, pic1Id, pic2Id
           FROM piece_pics WHERE jobCardId IN (${ph})`,
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
      // B3 fix: per-unit → total via × wipQty. See worker.ts:1475 comment.
      // jcMinutesTotal applies that ×wipQty for normal depts and skips it for
      // FAB_CUT (estMinutes/actualMinutes is already the per-SET total there).
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

      // Per-worker pro-rated share — same logic as the admin endpoint.
      // B3 fix: pieces path iterates pieces.length (= wipQty) times so
      // jcMins-per-piece sums to total naturally. Legacy path treats the
      // JC as one chunk → needs × wipQty.
      const jcMins = jc.estMinutes ?? jc.actualMinutes ?? 0;
      const pieces = picsByJc.get(jc.id) ?? [];
      const perWorkerMins = new Map<string, number>();
      if (pieces.length > 0) {
        // Per-piece minute base. Non-FAB_CUT: jcMins is per-piece, so each
        // piece row credits jcMins (summed over pieces.length ≈ wipQty → JC
        // total). FAB_CUT stores the per-SET total on the JC (not per-piece),
        // so the per-piece base is total ÷ piece count — keeps the per-piece
        // sum equal to jcMinutesTotal instead of total × piece count (the 3×
        // over-count this fix removes). Mirrors department-performance.ts.
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

  return c.json({
    success: true,
    data: {
      isLeader: true,
      range: { from: fromStr, to: toStr },
      departmentCode,
      category,
      availableDepartments: leaderDepts,
      availableCategories: allowedCats,
      totals: {
        workingMinutes: totalWorking,
        productionMinutes: totalProduction,
        // Prod vs non-prod working-minute split for the /worker/team KPI
        // subtitle. Production = WHE rows whose departmentCode has
        // isProduction=1. Non-production = the rest (Warehousing / Repair
        // / Maintenance / Production Shortfall). The Avg Efficiency
        // denominator is productionWorkingMinutes; the headline Working
        // Hrs card sums both so the operator can reconcile the two.
        productionWorkingMinutes: totalProductionWorkingMinutes,
        nonProductionWorkingMinutes: totalNonProductionWorkingMinutes,
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

// ============================================================
// POST /api/worker/rack-bulk-stock-in
//
// Worker-portal bulk RACK STOCK-IN. The phone scans a rack + a batch of
// pieces, then posts them all at once. For each item we write one rack_items
// row AND one STOCK_IN stock_movements row, then flip the rack to OCCUPIED.
//
// Mirrors the admin-side stock-in write in routes/warehouse.ts: the SQL uses
// the same camelCase identifiers (rackLocationId / productionOrderId /
// productCode / productName / sizeLabel / customerName / rackLabel /
// performedBy) that the supabase-compat rename map translates to snake_case.
// rack_items.id is BIGSERIAL, so the INSERT does NOT supply id.
//
// Body: { rackLocationId, items: [{ productCode, productName?,
//          productionOrderId?, sizeLabel?, customerName?, qty? }] }
// ============================================================
app.post("/rack-bulk-stock-in", async (c) => {
  const auth = await getWorker(c);
  if (!auth.ok) return auth.response;
  const { worker } = auth;
  try {
    const body = await c.req.json().catch(() => ({}));
    const { rackLocationId, items } = body as {
      rackLocationId?: string;
      items?: Array<{
        productCode?: string;
        productName?: string;
        productionOrderId?: string;
        sizeLabel?: string;
        customerName?: string;
        qty?: number;
      }>;
    };
    if (!rackLocationId || !Array.isArray(items) || items.length === 0) {
      return c.json(
        { ok: false, error: "rackLocationId and a non-empty items array are required" },
        400,
      );
    }

    // Rack existence check (audit M1) — a stale/deleted HKRACK token would
    // otherwise 500 on the rack_items FK; return a clean 404 instead.
    const rack = await c.var.DB.prepare(
      "SELECT id FROM rack_locations WHERE id = ? LIMIT 1",
    )
      .bind(rackLocationId)
      .first<{ id: string }>();
    if (!rack) {
      return c.json({ ok: false, error: "rack not found" }, 404);
    }

    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    // Atomic (audit H1): build EVERY write into one db.batch() so a mid-loop
    // failure can't half-stock the rack, and a retry can't double-insert
    // (inflating inventory). Mirrors the admin replaceRackItems pattern
    // (routes/warehouse.ts), which uses the same transactional batch.
    const statements: D1PreparedStatement[] = [];
    for (const item of items) {
      const qty = item.qty ?? 1;
      // production_order_id stored NULL (not "") when absent, consistent with the
      // movement row + so the movements-view PO JOIN reads "no document".
      const poId = item.productionOrderId || null;
      // rack_items.id is BIGSERIAL — not supplied here.
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO rack_items (rackLocationId, productionOrderId,
             productCode, productName, sizeLabel, customerName, qty,
             stockedInDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          rackLocationId,
          poId,
          item.productCode ?? "",
          item.productName ?? "",
          item.sizeLabel ?? "",
          item.customerName ?? "",
          qty,
          today,
          "",
        ),
      );
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO stock_movements (id, type, rackLocationId, rackLabel,
             productionOrderId, productCode, productName, quantity, reason,
             performedBy, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          genId("sm"),
          "STOCK_IN",
          rackLocationId,
          rackLocationId,
          poId,
          item.productCode ?? "",
          item.productName ?? "",
          qty,
          "Bulk stock-in (scan)",
          worker.name,
          now,
        ),
      );
    }
    statements.push(
      c.var.DB
        .prepare("UPDATE rack_locations SET status = 'OCCUPIED' WHERE id = ?")
        .bind(rackLocationId),
    );
    await c.var.DB.batch(statements);

    return c.json({ ok: true, count: items.length });
  } catch (error) {
    return c.json({ ok: false, error: String(error) }, 500);
  }
});

export default app;
