// labour-projection — a month's labour cost per department WITHOUT payslips.
//
// Owner 2026-08-31 (P&L auto-extract): a month whose payroll has not been
// generated yet must still show labour on the P&L. This is a DRY RUN of the
// payslip-generation maths — the same computeMonthlyLabor engine, the same
// effective-dated salaries/pay rules, the same efficiency allowance and
// employer statutory — aggregated per department and NEVER stored. When the
// owner later presses Generate, the stored payslips replace this number with
// the exact same figures (one engine, no jump).
//
// Deliberately NOT computed here: PCB (employee tax — needs YTD context and
// affects net pay, not company cost), advances, bank details. Company cost =
// gross (basic earned + OT + efficiency allowance) + employer EPF/SOCSO/EIS.
//
// Mirrors src/api/routes/payslips.ts GET /projected + POST / — if that loop
// gains a new cost component, add it here too (grep: labour-projection).

import type { Env } from "../worker";
import {
  computeMonthlyLabor,
  absenceCutoffDay,
  effectiveSalarySenForMonth,
} from "../../lib/labor-engine";
import {
  computeMonthlyEfficiencyByWorker,
  resolveEfficiencyAllowanceSen,
  monthBounds,
} from "./efficiency-allowance";
import { resolvePayRulesAsOf } from "../../lib/pay-rules";
import { loadPayRuleVersions } from "./pay-rules-store";
import { calcStatutory } from "../routes/payslips";

export type ProjectedDeptCost = {
  departmentCode: string;
  workers: number;
  grossSen: number;
  epfSen: number;
  socsoSen: number;
  eisSen: number;
};

// Field types mirror payslips.ts WorkerRow so the engine sees the exact same
// shapes the generate route feeds it (statutory toggles: NULL → enabled).
type ProjWorkerRow = {
  id: string;
  departmentCode: string | null;
  status: string;
  basicSalarySen: number;
  workingDaysPerMonth: number;
  workingHoursPerDay: number;
  otMultiplier: number;
  epfEnabled: boolean | null;
  socsoEnabled: boolean | null;
  eisEnabled: boolean | null;
  resignedAt: string | null;
  joinDate: string | null;
  efficiencyAllowanceSen: number | null;
  efficiencyThresholdPct: number | null;
  payMode: string | null;
  dailyRateSen: number | null;
};

export async function projectedLabourByDept(
  db: Env["Variables"]["DB"],
  period: string,
): Promise<ProjectedDeptCost[]> {
  if (!/^\d{4}-\d{2}$/.test(period)) return [];
  const [pYear, pMonth] = period.split("-").map(Number);

  const wres = await db
    .prepare(
      "SELECT id, departmentCode, status, basicSalarySen, workingDaysPerMonth, workingHoursPerDay, otMultiplier, epfEnabled, socsoEnabled, eisEnabled, resignedAt, joinDate, efficiencyAllowanceSen, efficiencyThresholdPct, payMode, dailyRateSen FROM workers WHERE (status = 'ACTIVE' OR (status = 'RESIGNED' AND resignedAt LIKE ?)) AND empNo NOT LIKE 'TEST%'",
    )
    .bind(`${period}-%`)
    .all<ProjWorkerRow>();
  const workers = wres.results ?? [];
  if (!workers.length) return [];

  const phRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) publicHolidays.add(d);
        }
      }
    } catch { /* malformed — no holidays */ }
  }

  const wheRes = await db
    .prepare("SELECT workerId, date, hours FROM working_hour_entries WHERE date LIKE ?")
    .bind(`${period}-%`)
    .all<{ workerId: string; date: string; hours: number }>();
  const daysByWorker = new Map<string, { date: string; hours: number }[]>();
  for (const r of wheRes.results ?? []) {
    const arr = daysByWorker.get(r.workerId) ?? [];
    arr.push({ date: r.date, hours: Number(r.hours) || 0 });
    daysByWorker.set(r.workerId, arr);
  }
  // A month with no clock data at all projects to nothing — an empty factory
  // month must not invent a full payroll out of base salaries alone.
  if (!daysByWorker.size) return [];

  const deductionHoursByWorker = new Map<string, number>();
  try {
    const dedRes = await db
      .prepare("SELECT workerId, hours FROM payroll_hour_deductions WHERE date LIKE ?")
      .bind(`${period}-%`)
      .all<{ workerId: string; hours: number }>();
    for (const r of dedRes.results ?? []) {
      deductionHoursByWorker.set(
        r.workerId,
        (deductionHoursByWorker.get(r.workerId) ?? 0) + (Number(r.hours) || 0),
      );
    }
  } catch { /* table absent — no docks */ }

  const periodEndYmd = `${period}-${String(new Date(pYear, pMonth, 0).getDate()).padStart(2, "0")}`;
  const payRuleVersions = await loadPayRuleVersions(db);
  const statutoryRules = resolvePayRulesAsOf(payRuleVersions, periodEndYmd);

  const salaryHistoryByWorker = new Map<string, Array<{ effectiveFrom: string; basicSalarySen: number }>>();
  try {
    const wshRes = await db
      .prepare("SELECT workerId, basicSalarySen, effectiveFrom FROM worker_salary_history")
      .all<{ workerId: string; basicSalarySen: number; effectiveFrom: string }>();
    for (const r of wshRes.results ?? []) {
      const arr = salaryHistoryByWorker.get(r.workerId) ?? [];
      arr.push({ effectiveFrom: r.effectiveFrom, basicSalarySen: Number(r.basicSalarySen) || 0 });
      salaryHistoryByWorker.set(r.workerId, arr);
    }
  } catch { /* migration absent — current scalar salary */ }

  const absenceThroughDay = absenceCutoffDay(
    pYear,
    pMonth,
    new Date(),
    statutoryRules.absenceGraceWorkingDays,
    publicHolidays,
  );

  const effBounds = monthBounds(period);
  const effByWorker = await computeMonthlyEfficiencyByWorker(db, effBounds.start, effBounds.end);

  const periodLastIso = periodEndYmd;
  const agg = new Map<string, ProjectedDeptCost>();
  for (const worker of workers) {
    if (
      typeof worker.joinDate === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(worker.joinDate) &&
      worker.joinDate > periodLastIso
    ) continue;
    const joinedDay =
      typeof worker.joinDate === "string" && worker.joinDate.startsWith(`${period}-`)
        ? Number(worker.joinDate.slice(8, 10))
        : undefined;
    const resignedDay =
      worker.status === "RESIGNED" &&
      typeof worker.resignedAt === "string" &&
      worker.resignedAt.startsWith(`${period}-`)
        ? Number(worker.resignedAt.slice(8, 10))
        : undefined;

    const effectiveSalarySen = effectiveSalarySenForMonth(
      salaryHistoryByWorker.get(worker.id) ?? [],
      worker.basicSalarySen,
      pYear,
      pMonth,
      publicHolidays,
    );

    const labor = computeMonthlyLabor({
      worker: {
        basicSalarySen: effectiveSalarySen,
        payMode: worker.payMode,
        dailyRateSen: worker.dailyRateSen,
        workingDaysPerMonth: worker.workingDaysPerMonth,
        workingHoursPerDay: worker.workingHoursPerDay,
        otMultiplier: worker.otMultiplier,
      },
      year: pYear,
      month: pMonth,
      days: daysByWorker.get(worker.id) ?? [],
      publicHolidays,
      absenceThroughDay,
      employmentStartDay: joinedDay,
      employmentEndDay: resignedDay,
      prorateToService: joinedDay !== undefined || resignedDay !== undefined,
      shortHourDeductionHours: deductionHoursByWorker.get(worker.id) ?? 0,
      payRuleVersions,
    });

    const allowances = resolveEfficiencyAllowanceSen(
      effByWorker.get(worker.id),
      worker.efficiencyAllowanceSen,
      worker.efficiencyThresholdPct,
      { workingDays: worker.workingDaysPerMonth, absentDays: labor.payroll.absentDays },
    );

    // Employer statutory only — pcbEnabled:false keeps the PCB engine (and
    // its YTD context) entirely out of a cost projection.
    const stat = calcStatutory(
      effectiveSalarySen,
      {
        epfEnabled: worker.epfEnabled,
        socsoEnabled: worker.socsoEnabled,
        eisEnabled: worker.eisEnabled,
        pcbEnabled: false,
      },
      statutoryRules,
      {
        year: pYear,
        monthIndex: pMonth,
        remunerationSen: labor.payroll.grossSen,
        profile: { residency: null, category: null, childReliefSen: null },
        ytdRemunerationSen: 0,
        ytdEpfSen: 0,
        ytdPcbSen: 0,
      },
    );

    const dept = String(worker.departmentCode ?? "").trim() || "(unassigned)";
    const cur = agg.get(dept) ?? { departmentCode: dept, workers: 0, grossSen: 0, epfSen: 0, socsoSen: 0, eisSen: 0 };
    cur.workers += 1;
    cur.grossSen += labor.payroll.grossSen + allowances;
    cur.epfSen += stat.epfEmployer;
    cur.socsoSen += stat.socsoEmployer;
    cur.eisSen += stat.eisEmployer;
    agg.set(dept, cur);
  }
  return [...agg.values()].sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));
}
