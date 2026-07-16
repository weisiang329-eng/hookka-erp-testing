// ---------------------------------------------------------------------------
// employee-agent.ts — the Employee (HR) Agent's daily read-only digest.
//
// Owner 2026-07-16: "一个 agent 专门顾 employee". Surfaces the day's people
// anomalies so nothing slips before payroll. STRICTLY READ-ONLY — it never
// touches attendance, hours or pay; it only reports. Every number is derived
// from the same sources the HR screens use:
//   • absences   — ACTIVE workers with no clock-in today (attendance_records)
//   • late       — clock-in after 08:00 + grace (attendance-rules)
//   • pre-payroll— worker_nonprod_requests still PENDING (need a decision)
//   • low-eff    — computeMonthlyEfficiencyByWorker over the trailing 7 days
// ---------------------------------------------------------------------------
import {
  HOOKKA_ATTENDANCE,
  hhmmToMinutes,
} from "../../lib/attendance-rules";
import { computeMonthlyEfficiencyByWorker } from "./efficiency-allowance";
import { ensureNonprodRequests } from "../routes/worker";

/** Efficiency below this (%) over the trailing week flags a worker. */
const LOW_EFFICIENCY_PCT = 55;
/** Trailing window for the efficiency signal — a single day is too thin. */
const EFFICIENCY_WINDOW_DAYS = 7;

export interface EmployeeDigest {
  date: string;
  absent: Array<{ workerId: string; name: string; dept: string }>;
  late: Array<{ workerId: string; name: string; dept: string; clockIn: string; lateMin: number }>;
  pendingApprovals: number;
  lowEfficiency: Array<{ workerId: string; name: string; pct: number }>;
  counts: { absent: number; late: number; pendingApprovals: number; lowEfficiency: number };
}

function mytToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAgoYmd(ymd: string, back: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute (but never write) the day's employee digest. Each block fails soft —
 * one broken query returns an empty list, never a 500, so the console card
 * always renders.
 */
export async function runEmployeeDigest(
  db: D1Database,
  todayYmd: string = mytToday(),
): Promise<EmployeeDigest> {
  // Active roster → name/dept lookup (reused by absence + low-eff).
  const roster = new Map<string, { name: string; dept: string }>();
  try {
    const r = await db
      .prepare("SELECT id, name, departmentCode FROM workers WHERE status = 'ACTIVE'")
      .bind()
      .all<{ id: string; name?: string; departmentCode?: string; department_code?: string }>();
    for (const w of r.results ?? []) {
      roster.set(w.id, {
        name: w.name ?? w.id,
        dept: (w.departmentCode ?? w.department_code ?? "") as string,
      });
    }
  } catch (e) {
    console.warn("[employee-agent] roster load failed:", e);
  }

  // 1 · Absences — active workers with no clock-in today.
  const absent: EmployeeDigest["absent"] = [];
  try {
    const r = await db
      .prepare(
        `SELECT w.id AS workerId, w.name AS name, w.departmentCode AS departmentCode
           FROM workers w
           LEFT JOIN attendance_records a ON a.employeeId = w.id AND a.date = ?
          WHERE w.status = 'ACTIVE' AND (a.id IS NULL OR a.clockIn IS NULL)
          ORDER BY w.departmentCode, w.name`,
      )
      .bind(todayYmd)
      .all<{ workerId: string; name?: string; departmentCode?: string; departmentcode?: string }>();
    for (const w of r.results ?? []) {
      absent.push({
        workerId: w.workerId,
        name: w.name ?? w.workerId,
        dept: (w.departmentCode ?? w.departmentcode ?? "") as string,
      });
    }
  } catch (e) {
    console.warn("[employee-agent] absence query failed:", e);
  }

  // 2 · Late punches — clock-in after 08:00 + grace (global rule; the pay-rule
  //     version override is a refinement we can layer later).
  const late: EmployeeDigest["late"] = [];
  const lateThreshold = HOOKKA_ATTENDANCE.startMin + HOOKKA_ATTENDANCE.lateGraceMin;
  try {
    const r = await db
      .prepare(
        `SELECT employeeId AS workerId, employeeName AS name,
                departmentCode AS departmentCode, clockIn AS clockIn
           FROM attendance_records
          WHERE date = ? AND clockIn IS NOT NULL`,
      )
      .bind(todayYmd)
      .all<{ workerId: string; name?: string; departmentCode?: string; departmentcode?: string; clockIn?: string; clockin?: string }>();
    for (const a of r.results ?? []) {
      const hhmm = (a.clockIn ?? a.clockin ?? "") as string;
      const mins = hhmmToMinutes(hhmm);
      if (mins == null) continue;
      const lateMin = mins - lateThreshold;
      if (lateMin > 0) {
        late.push({
          workerId: a.workerId,
          name: a.name ?? a.workerId,
          dept: (a.departmentCode ?? a.departmentcode ?? "") as string,
          clockIn: hhmm,
          lateMin,
        });
      }
    }
    late.sort((x, y) => y.lateMin - x.lateMin);
  } catch (e) {
    console.warn("[employee-agent] late query failed:", e);
  }

  // 3 · Pre-payroll — non-prod / add-prod requests still awaiting a decision.
  let pendingApprovals = 0;
  try {
    await ensureNonprodRequests(db);
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM worker_nonprod_requests WHERE status = 'PENDING'")
      .bind()
      .first<{ n: number | string }>();
    pendingApprovals = Number(r?.n) || 0;
  } catch (e) {
    console.warn("[employee-agent] pending-approvals query failed:", e);
  }

  // 4 · Low efficiency — trailing-week production efficiency below the floor.
  const lowEfficiency: EmployeeDigest["lowEfficiency"] = [];
  try {
    const from = daysAgoYmd(todayYmd, EFFICIENCY_WINDOW_DAYS - 1);
    const effMap = await computeMonthlyEfficiencyByWorker(db, from, todayYmd);
    for (const [workerId, e] of effMap) {
      if (e.pct != null && e.pct < LOW_EFFICIENCY_PCT && e.prodHours >= 4) {
        lowEfficiency.push({
          workerId,
          name: roster.get(workerId)?.name ?? workerId,
          pct: Math.round(e.pct),
        });
      }
    }
    lowEfficiency.sort((x, y) => x.pct - y.pct);
  } catch (e) {
    console.warn("[employee-agent] efficiency compute failed:", e);
  }

  return {
    date: todayYmd,
    absent,
    late,
    pendingApprovals,
    lowEfficiency,
    counts: {
      absent: absent.length,
      late: late.length,
      pendingApprovals,
      lowEfficiency: lowEfficiency.length,
    },
  };
}
