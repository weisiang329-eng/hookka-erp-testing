// ============================================================
// Worker Route — per-worker scoped endpoints for the /worker
// mobile portal.
//
// Every endpoint resolves the caller via `X-Worker-Token` and
// returns data scoped to that worker only — they can never read
// another worker's payslips, leaves, or attendance.
// ============================================================
import { Hono } from 'hono';
import {
  workers,
  attendanceRecords,
  payslipDetails,
  leaveRecords,
  productionOrders,
  departments,
  generateId,
} from '../../lib/mock-data';
import type { AttendanceRecord, AttendanceStatus } from '../../lib/mock-data';
import type { Env } from '../worker';
import { resolveWorkerToken } from './worker-auth';

const app = new Hono<Env>();

// Piece-rate per department (in sen). MVP flat-rate — replace
// with per-operation rates from a config table later. Tuned to
// rough Malaysian furniture factory norms.
export const PIECE_RATE_SEN: Record<string, number> = {
  FAB_CUT: 200,    // RM 2.00 per cut piece
  FAB_SEW: 300,    // RM 3.00 per sewn panel
  FOAM: 250,
  WOOD_CUT: 400,
  FRAMING: 500,
  WEBBING: 300,
  UPHOLSTERY: 800, // RM 8.00 — most valuable operation
  PACKING: 150,
};

// Resolve the worker from the auth header, or short-circuit with
// a 401 response. Returns either the resolved worker object or the
// Response to bail out with. Async since P3.5 — resolveWorkerToken
// hits D1 (worker_sessions table) instead of an in-process Map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requireWorker(c: any): Promise<
  | { ok: true; workerId: string; worker: (typeof workers)[number] }
  | { ok: false; res: Response }
> {
  const token = c.req.header('x-worker-token');
  const workerId = await resolveWorkerToken(c.var.DB, token);
  if (!workerId) {
    return { ok: false, res: c.json({ success: false, error: 'Not authenticated' }, 401) };
  }
  const w = workers.find((x) => x.id === workerId);
  if (!w) {
    return { ok: false, res: c.json({ success: false, error: 'Worker not found' }, 404) };
  }
  return { ok: true, workerId, worker: w };
}

// ----- GET /api/worker/today -----
// Home-screen data: clock status, pieces done today, earnings
// estimate, and counts of pending/in-progress job cards assigned
// to me.
app.get('/today', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { workerId, worker } = auth;

  const today = new Date().toISOString().slice(0, 10);
  const attendance = attendanceRecords.find(
    (r) => r.employeeId === workerId && r.date === today,
  );

  // Find every job card assigned to me across the production board.
  // A card is "mine" if I'm pic1 or pic2.
  let pending = 0;
  let inProgress = 0;
  let doneToday = 0;
  const doneByDept: Record<string, number> = {};

  for (const o of productionOrders) {
    for (const jc of o.jobCards) {
      // "Mine" — either I'm on the JC-level legacy pic (A-flow), or I'm
      // on at least one piecePic slot (B-flow). The B-flow also drives
      // the doneToday counter below at PIECE granularity.
      const onPiecePic =
        jc.piecePics?.some(
          (s) => s.pic1Id === workerId || s.pic2Id === workerId,
        ) || false;
      const onLegacyPic = jc.pic1Id === workerId || jc.pic2Id === workerId;
      const mine = onPiecePic || onLegacyPic;
      if (!mine) continue;

      if (jc.status === 'COMPLETED' || jc.status === 'TRANSFERRED') {
        if (jc.completedDate && jc.completedDate.slice(0, 10) === today) {
          // Count PIECES, not JCs — a qty=2 Divan with both pieces done by
          // this worker is 2 items toward their daily count. Fall back to 1
          // when piecePics is missing (legacy A-flow JCs).
          let myPieces = 0;
          if (jc.piecePics && jc.piecePics.length > 0) {
            for (const s of jc.piecePics) {
              if (s.pic1Id === workerId || s.pic2Id === workerId) myPieces++;
            }
          } else {
            myPieces = 1;
          }
          if (myPieces > 0) {
            doneToday += myPieces;
            doneByDept[jc.departmentCode] =
              (doneByDept[jc.departmentCode] ?? 0) + myPieces;
          }
        }
      } else if (jc.status === 'IN_PROGRESS') {
        inProgress += 1;
      } else if (jc.status === 'WAITING' || jc.status === 'PAUSED') {
        pending += 1;
      }
    }
  }

  // Sum earnings by the dept that produced each piece — a worker
  // can cross depts during the day and we still want accurate $$.
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
        departmentCode: worker.departmentCode,
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

// ----- POST /api/worker/clock -----
// Body: { action: 'CLOCK_IN' | 'CLOCK_OUT' }
// Punch in/out for the current worker. Mirrors the admin /attendance
// endpoint but scoped to the caller's identity — no spoofing.
app.post('/clock', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { worker } = auth;

  const body = await c.req.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  if (action !== 'CLOCK_IN' && action !== 'CLOCK_OUT') {
    return c.json({ success: false, error: 'Invalid action' }, 400);
  }

  const date = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`;

  let record = attendanceRecords.find(
    (r) => r.employeeId === worker.id && r.date === date,
  );

  if (action === 'CLOCK_IN') {
    if (record) {
      // Idempotent — tapping clock-in twice shouldn't lose the original time.
      if (!record.clockIn) record.clockIn = time;
      record.status = 'PRESENT';
    } else {
      const dept = departments.find((d) => d.id === worker.departmentId);
      record = {
        id: generateId(),
        employeeId: worker.id,
        employeeName: worker.name,
        departmentCode: worker.departmentCode,
        departmentName: dept?.shortName || '',
        date,
        clockIn: time,
        clockOut: null,
        status: 'PRESENT' as AttendanceStatus,
        workingMinutes: 0,
        productionTimeMinutes: 0,
        efficiencyPct: 0,
        overtimeMinutes: 0,
        deptBreakdown: [
          { deptCode: worker.departmentCode, minutes: 0, productCode: '' },
        ],
        notes: '',
      } as AttendanceRecord;
      attendanceRecords.push(record);
    }
    return c.json({ success: true, data: record });
  }

  // CLOCK_OUT
  if (!record) {
    return c.json(
      { success: false, error: 'No clock-in record for today' },
      400,
    );
  }
  record.clockOut = time;
  if (record.clockIn) {
    const [inH, inM] = record.clockIn.split(':').map(Number);
    const [outH, outM] = time.split(':').map(Number);
    const totalMinutes = outH * 60 + outM - (inH * 60 + inM);
    record.workingMinutes = Math.max(0, totalMinutes);
    record.productionTimeMinutes = Math.max(
      0,
      Math.round(totalMinutes * 0.85),
    );
    const standardMinutes = (worker.workingHoursPerDay || 9) * 60;
    record.overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);
  }
  return c.json({ success: true, data: record });
});

// ----- GET /api/worker/history?from=YYYY-MM-DD&to=YYYY-MM-DD -----
// Attendance + completed job cards for the current worker. The
// `from` / `to` query params filter BOTH datasets so the worker can
// drill into any date range — a specific week, a pay period, last
// month's figures vs this month, whatever.
//
// If no range is passed, defaults to the last 30 days.
app.get('/history', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { workerId } = auth;

  // Parse + default the range. Always yields valid YYYY-MM-DD strings
  // so downstream string compares stay simple.
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const thirtyAgo = new Date(today.getTime() - 30 * 86400000);
  const defaultFrom = thirtyAgo.toISOString().slice(0, 10);
  const fromStr = (c.req.query('from') || defaultFrom).slice(0, 10);
  const toStr = (c.req.query('to') || defaultTo).slice(0, 10);

  // Attendance in range
  const attendance = attendanceRecords
    .filter(
      (r) =>
        r.employeeId === workerId && r.date >= fromStr && r.date <= toStr,
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => ({
      date: r.date,
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      workingMinutes: r.workingMinutes,
      productionTimeMinutes: r.productionTimeMinutes,
      efficiencyPct: r.efficiencyPct,
      overtimeMinutes: r.overtimeMinutes,
      status: r.status,
    }));

  // Completed job cards — walk every production order, pick cards where
  // this worker has a slot (either piecePic slot OR legacy jc-level pic).
  //
  // Per-piece attribution: for each piecePic slot this worker occupies,
  // compute their share. `myMinutes` on each row = this worker's credit
  // for THIS JC across all pieces they worked on:
  //   Σ (jc.estMinutes / totalPieces / picsOnThatPiece)
  // When qty=2 and worker did both pieces solo → full estMinutes.
  // When qty=2 and worker shared one piece with someone else → 75% credit.
  // When piecePics is absent (A-flow / legacy seed), fall back to the
  // JC-level pic1/pic2 share (halve if both filled).
  //
  // We include WIP metadata (wipLabel, wipCode, itemCategory, sizeLabel)
  // so the worker portal's "Today's completed" list can show the piece
  // name (e.g. `8" Divan- 5FT (WD)`) instead of the generic productCode —
  // on a bedframe PO the same productCode applies to both Divan and HB
  // cards, so the worker couldn't otherwise tell which piece they did.
  type CompletedCard = {
    jobCardId: string;
    orderPoNo: string;
    productCode: string;
    productName: string;
    departmentCode: string;
    estMinutes: number;
    actualMinutes: number | null;
    myMinutes: number;       // this worker's share after piece + co-PIC splits
    piecesWorked: number;    // count of physical pieces this worker touched
    piecesShared: number;    // of those, how many were 2-worker share
    totalPieces: number;     // total pieces on this JC (= wipQty)
    completedDate: string | null;
    role: 'PIC1' | 'PIC2' | 'MIXED';
    wipLabel?: string;
    wipCode?: string;
    itemCategory?: string;
    sizeLabel?: string;
  };
  const completed: CompletedCard[] = [];
  for (const o of productionOrders) {
    for (const jc of o.jobCards) {
      if (jc.status !== 'COMPLETED' && jc.status !== 'TRANSFERRED') continue;
      const d = (jc.completedDate || '').slice(0, 10);
      if (d && (d < fromStr || d > toStr)) continue;

      const pieces = jc.piecePics || [];
      let myMinutes = 0;
      let piecesWorked = 0;
      let piecesShared = 0;
      let role: 'PIC1' | 'PIC2' | 'MIXED' = 'PIC1';
      const rolesSeen = new Set<'PIC1' | 'PIC2'>();

      if (pieces.length > 0) {
        // estMinutes is stored PER PIECE (the time to produce one unit),
        // not a total across all pieces on the JC. So a qty=2 Divan with
        // estMinutes=20 means 20 min per Divan piece → 40 min if both are
        // produced. We credit each piece at `estMinutes` (not /totalPieces),
        // then halve only when two workers shared that single piece.
        const perPieceMinutes = jc.estMinutes || 0;
        for (const s of pieces) {
          const isPic1 = s.pic1Id === workerId;
          const isPic2 = s.pic2Id === workerId;
          if (!isPic1 && !isPic2) continue;
          const picCount = (s.pic1Id ? 1 : 0) + (s.pic2Id ? 1 : 0);
          myMinutes += perPieceMinutes / Math.max(1, picCount);
          piecesWorked++;
          if (picCount >= 2) piecesShared++;
          if (isPic1) rolesSeen.add('PIC1');
          if (isPic2) rolesSeen.add('PIC2');
        }
        if (piecesWorked === 0) continue; // no pieces for this worker on this JC
        role =
          rolesSeen.size === 2
            ? 'MIXED'
            : rolesSeen.has('PIC2')
              ? 'PIC2'
              : 'PIC1';
      } else {
        // Legacy / A-flow path: no piecePics, use JC-level pic fields.
        if (jc.pic1Id !== workerId && jc.pic2Id !== workerId) continue;
        const coPicCount =
          (jc.pic1Id ? 1 : 0) + (jc.pic2Id ? 1 : 0);
        myMinutes = (jc.estMinutes || 0) / Math.max(1, coPicCount);
        piecesWorked = 1;
        piecesShared = coPicCount >= 2 ? 1 : 0;
        role = jc.pic1Id === workerId ? 'PIC1' : 'PIC2';
      }

      completed.push({
        jobCardId: jc.id,
        orderPoNo: o.poNo,
        productCode: o.productCode,
        productName: o.productName,
        departmentCode: jc.departmentCode,
        estMinutes: jc.estMinutes,
        actualMinutes: jc.actualMinutes,
        myMinutes: Math.round(myMinutes),
        piecesWorked,
        piecesShared,
        totalPieces: pieces.length || (jc.wipQty || 1),
        completedDate: jc.completedDate,
        role,
        wipLabel: (jc as { wipLabel?: string }).wipLabel,
        wipCode: (jc as { wipCode?: string }).wipCode,
        itemCategory: (o as { itemCategory?: string }).itemCategory,
        sizeLabel: (o as { sizeLabel?: string }).sizeLabel,
      });
    }
  }
  completed.sort((a, b) =>
    (b.completedDate || '').localeCompare(a.completedDate || ''),
  );

  // ---- Per-day roll-up ----
  // Shape matches the "Employee Detail Dashboard" reference: one row
  // per calendar date with Working Hours + Production Time so the
  // worker can see their day-by-day output on a single line.
  //
  // Working Hours come from the attendance record for the day.
  // Production Time = sum of every completed card's production time
  // that closed on the same date (uses estMinutes as the piece-rate
  // basis — that's what the production sheet uses too).
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
      departmentName: '',
      workingMinutes: r.workingMinutes,
      productionMinutes: 0,
    });
  }
  for (const c2 of completed) {
    const d = (c2.completedDate || '').slice(0, 10);
    if (!d) continue;
    if (d < fromStr || d > toStr) continue;
    const prev = dailyMap.get(d) || {
      date: d,
      departmentName: '',
      workingMinutes: 0,
      productionMinutes: 0,
    };
    // Use per-worker share (myMinutes) — halved when shared with a co-PIC,
    // and pro-rated when only some of the JC's pieces were ours.
    prev.productionMinutes += c2.myMinutes || 0;
    if (!prev.departmentName) prev.departmentName = c2.departmentCode;
    dailyMap.set(d, prev);
  }
  const daily = Array.from(dailyMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // Totals reflect the current range. Production minutes is the worker's
  // SHARE of each JC (myMinutes), so co-PIC jobs count at half, and jobs
  // where the worker only did some of the pieces count pro-rata.
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
    // Efficiency = production / working, capped at >= 0
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

// ----- GET /api/worker/payslips -----
// Self-service payslip history + current month estimate.
app.get('/payslips', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { workerId, worker } = auth;

  // Historical payslips owned by this worker
  const mine = payslipDetails
    .filter((p) => p.employeeId === workerId)
    .sort((a, b) => b.period.localeCompare(a.period));

  // Naive current-month estimate: pro-rated basic + OT so far + piece bonus.
  const today = new Date();
  const period = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const monthPrefix = period + '-';
  const monthDays = attendanceRecords.filter(
    (r) => r.employeeId === workerId && r.date.startsWith(monthPrefix),
  );
  const workedDays = monthDays.filter(
    (r) => r.status === 'PRESENT' || r.status === 'HALF_DAY',
  ).length;
  const otMinutes = monthDays.reduce((s, r) => s + (r.overtimeMinutes || 0), 0);

  // Proration
  const daysInMonth = worker.workingDaysPerMonth || 26;
  const basicEarnedSen = Math.round(
    (worker.basicSalarySen / daysInMonth) * workedDays,
  );
  // OT rate = basic / daysInMonth / workingHours × 1.5
  const hourlyRateSen =
    worker.basicSalarySen / daysInMonth / (worker.workingHoursPerDay || 8);
  const otSen = Math.round((otMinutes / 60) * hourlyRateSen * 1.5);

  // Piece bonus for completed cards this month
  let pieceBonusSen = 0;
  for (const o of productionOrders) {
    for (const jc of o.jobCards) {
      if (jc.pic1Id !== workerId && jc.pic2Id !== workerId) continue;
      if (jc.status !== 'COMPLETED' && jc.status !== 'TRANSFERRED') continue;
      const d = (jc.completedDate || '').slice(0, 10);
      if (!d.startsWith(monthPrefix)) continue;
      pieceBonusSen += PIECE_RATE_SEN[jc.departmentCode] ?? 0;
    }
  }

  return c.json({
    success: true,
    data: {
      current: {
        period,
        workedDays,
        otMinutes,
        basicEarnedSen,
        otSen,
        pieceBonusSen,
        estimatedGrossSen: basicEarnedSen + otSen + pieceBonusSen,
      },
      history: mine,
    },
  });
});

// ----- GET /api/worker/leaves -----
// Worker's leave balance + history + pending requests.
app.get('/leaves', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { workerId } = auth;

  const mine = leaveRecords
    .filter((r) => r.workerId === workerId)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));

  // Year-to-date usage
  const year = new Date().getFullYear();
  const yearPrefix = String(year);
  const usedAnnual = mine
    .filter(
      (r) =>
        r.type === 'ANNUAL' &&
        r.status === 'APPROVED' &&
        r.startDate.startsWith(yearPrefix),
    )
    .reduce((s, r) => s + (r.days || 0), 0);
  const usedMedical = mine
    .filter(
      (r) =>
        r.type === 'MEDICAL' &&
        r.status === 'APPROVED' &&
        r.startDate.startsWith(yearPrefix),
    )
    .reduce((s, r) => s + (r.days || 0), 0);

  // Standard Malaysian entitlements; tune per employment contract.
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

// ----- POST /api/worker/leaves -----
// File a leave request. Goes in as PENDING for HR to approve.
app.post('/leaves', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { worker } = auth;

  const body = await c.req.json().catch(() => ({}));
  const { type, startDate, endDate, reason } = body as {
    type?: string;
    startDate?: string;
    endDate?: string;
    reason?: string;
  };
  if (!type || !startDate || !endDate) {
    return c.json({ success: false, error: 'Missing fields' }, 400);
  }

  const s = new Date(startDate);
  const e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) {
    return c.json({ success: false, error: 'Invalid date range' }, 400);
  }
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;

  const record = {
    id: generateId(),
    workerId: worker.id,
    workerName: worker.name,
    type: type as 'ANNUAL' | 'MEDICAL' | 'UNPAID' | 'EMERGENCY' | 'PUBLIC_HOLIDAY',
    startDate,
    endDate,
    days,
    status: 'PENDING' as const,
    reason: reason || '',
  };
  leaveRecords.push(record);
  return c.json({ success: true, data: record });
});

// ----- POST /api/worker/issues -----
// Shop-floor issue report. Minimal fields; escalates to whoever
// monitors /approvals or /maintenance.
const issueStore: Array<{
  id: string;
  workerId: string;
  workerName: string;
  departmentCode: string;
  category: string;
  description: string;
  photoDataUrl?: string;
  reportedAt: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
}> = [];

app.post('/issues', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const { category, description, photoDataUrl } = body as {
    category?: string;
    description?: string;
    photoDataUrl?: string;
  };
  if (!category || !description) {
    return c.json({ success: false, error: 'Missing fields' }, 400);
  }
  const entry = {
    id: generateId(),
    workerId: worker.id,
    workerName: worker.name,
    departmentCode: worker.departmentCode,
    category,
    description,
    photoDataUrl,
    reportedAt: new Date().toISOString(),
    status: 'OPEN' as const,
  };
  issueStore.push(entry);
  return c.json({ success: true, data: { id: entry.id } });
});

app.get('/issues', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { workerId } = auth;
  const mine = issueStore
    .filter((i) => i.workerId === workerId)
    .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
    .slice(0, 20);
  return c.json({ success: true, data: mine });
});

// ----- PATCH /api/worker/profile -----
// Worker-editable fields: phone + emergency contact (stored in notes
// since Worker type has no emergency field yet — keep the schema change
// out of scope for MVP).
app.patch('/profile', async (c) => {
  const auth = await requireWorker(c);
  if (!auth.ok) return auth.res;
  const { worker } = auth;
  const body = await c.req.json().catch(() => ({}));
  const { phone } = body as { phone?: string };
  if (phone && typeof phone === 'string') worker.phone = phone;
  return c.json({ success: true, data: { phone: worker.phone } });
});

export default app;
