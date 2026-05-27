// ---------------------------------------------------------------------------
// Daily Efficiency Report — yesterday's per-employee + per-department
// work / production / efficiency breakdown, rendered as printable A4 HTML.
//
// Runs from two entry points (src/api/routes/reports.ts):
//   - POST /api/internal/reports/efficiency-trigger  (cron, x-cron-secret)
//   - GET  /api/reports/efficiency?date=YYYY-MM-DD   (in-browser print)
//
// Data sources mirror /api/department-performance:
//   - working_hour_entries  → worker × dept × date work minutes
//   - job_cards (COMPLETED/TRANSFERRED) + production_orders + piece_pics
//                          → production minutes per JC, pro-rated per worker
//   - workers + departments → names, dept rollup
//
// Pro-ration matches department-performance.ts: a JC's full
// (actualMinutes ?? estMinutes) × wipQty is credited once per its
// completedDate; per-worker share = total / |distinct workers credited|.
// ---------------------------------------------------------------------------

export interface EfficiencyEnv {
  RESEND_API_KEY?: string;
  BREVO_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  APP_URL?: string;
  DAILY_REPORT_RECIPIENTS?: string;
}

export interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  isProduction: number | null;
}

export interface WorkerSummary {
  workerId: string;
  empNo: string;
  name: string;
  departmentCode: string;
  departmentName: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  jobsCompleted: number;
}

export interface DepartmentSummary {
  code: string;
  name: string;
  shortName: string;
  workerCount: number;
  workingMinutes: number;
  productionMinutes: number;
  efficiencyPct: number;
  flagged: boolean; // efficiencyPct < LOW_EFFICIENCY_THRESHOLD
}

export interface EfficiencyData {
  date: string;
  generatedAtIso: string;
  totals: {
    presentCount: number;
    workerCount: number;
    workingMinutes: number;
    productionMinutes: number;
    efficiencyPct: number;
    jobsCompleted: number;
  };
  departments: DepartmentSummary[];
  workers: WorkerSummary[]; // sorted by department code, then by name
}

const LOW_EFFICIENCY_THRESHOLD = 60; // <60% flagged as red on the report

// D1-compat shape (the SupabaseAdapter installed in worker.ts exposes this).
interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

type WheRow = {
  workerId: string;
  date: string;
  departmentCode: string;
  category: string | null;
  hours: number | string | null;
};

type JcRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  pic1Id: string | null;
  pic2Id: string | null;
  completedDate: string | null;
  estMinutes: number | null;
  actualMinutes: number | null;
  wipQty: number | null;
};

type PicRow = { jobCardId: string; pic1Id: string | null; pic2Id: string | null };

type WorkerRow = {
  id: string;
  empNo: string | null;
  name: string;
  departmentCode: string | null;
  status: string | null;
};

type AttendanceRow = {
  employeeId: string;
  clockIn: string | null;
  clockOut: string | null;
  status: string;
};

export async function collectEfficiencyData(
  db: DbLike,
  dateYmd: string,
): Promise<EfficiencyData> {
  // 1. Departments — for rollup + name lookup.
  const deptRes = await db
    .prepare(
      `SELECT id, code, name, shortName, isProduction
         FROM departments ORDER BY code`,
    )
    .bind()
    .all<DepartmentRow>();
  const departments = deptRes.results ?? [];
  const deptByCode = new Map<string, DepartmentRow>();
  for (const d of departments) deptByCode.set(d.code, d);

  // 2. Active workers — every active worker is a row in the report, even
  //    if they had zero hours yesterday (absent / leave shows clearly).
  const wRes = await db
    .prepare(
      `SELECT id, empNo, name, departmentCode, status
         FROM workers WHERE status = 'ACTIVE'`,
    )
    .bind()
    .all<WorkerRow>();
  const allWorkers = wRes.results ?? [];

  // 3. Attendance for the date — pulls clock in/out + present/absent status.
  const attRes = await db
    .prepare(
      `SELECT employeeId, clockIn, clockOut, status
         FROM attendance_records WHERE date = ?`,
    )
    .bind(dateYmd)
    .all<AttendanceRow>();
  const attByWorker = new Map<string, AttendanceRow>();
  for (const a of attRes.results ?? []) attByWorker.set(a.employeeId, a);

  // 4. Working hour entries — sum minutes per worker.
  const wheRes = await db
    .prepare(
      `SELECT workerId, date, departmentCode, category, hours
         FROM working_hour_entries WHERE date = ?`,
    )
    .bind(dateYmd)
    .all<WheRow>();
  const workingMinsByWorker = new Map<string, number>();
  for (const r of wheRes.results ?? []) {
    const mins = Math.round((Number(r.hours) || 0) * 60);
    workingMinsByWorker.set(
      r.workerId,
      (workingMinsByWorker.get(r.workerId) ?? 0) + mins,
    );
  }

  // 5. Completed / transferred job cards on the date.
  const jcRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, pic1Id, pic2Id,
              completedDate, estMinutes, actualMinutes, wipQty
         FROM job_cards
        WHERE status IN ('COMPLETED','TRANSFERRED')
          AND completedDate = ?`,
    )
    .bind(dateYmd)
    .all<JcRow>();
  const jcs = jcRes.results ?? [];

  // 6. piece_pics for those JCs — adds the workers credited per piece.
  let pics: PicRow[] = [];
  if (jcs.length > 0) {
    const ph = jcs.map(() => "?").join(",");
    const r = await db
      .prepare(
        `SELECT jobCardId, pic1Id, pic2Id FROM piece_pics WHERE jobCardId IN (${ph})`,
      )
      .bind(...jcs.map((j) => j.id))
      .all<PicRow>();
    pics = r.results ?? [];
  }
  const picsByJc = new Map<string, PicRow[]>();
  for (const p of pics) {
    const arr = picsByJc.get(p.jobCardId) ?? [];
    arr.push(p);
    picsByJc.set(p.jobCardId, arr);
  }

  // 7. Pro-rate per JC: minutes / |distinct worker ids credited|.
  const productionMinsByWorker = new Map<string, number>();
  const jcsCompletedByWorker = new Map<string, number>();
  for (const jc of jcs) {
    const wipQty = Math.max(1, jc.wipQty ?? 1);
    const totalMins = (jc.actualMinutes ?? jc.estMinutes ?? 0) * wipQty;
    if (totalMins <= 0) continue;

    const workerIds = new Set<string>();
    if (jc.pic1Id) workerIds.add(jc.pic1Id);
    if (jc.pic2Id) workerIds.add(jc.pic2Id);
    for (const p of picsByJc.get(jc.id) ?? []) {
      if (p.pic1Id) workerIds.add(p.pic1Id);
      if (p.pic2Id) workerIds.add(p.pic2Id);
    }
    if (workerIds.size === 0) continue;

    const share = totalMins / workerIds.size;
    for (const wid of workerIds) {
      productionMinsByWorker.set(
        wid,
        (productionMinsByWorker.get(wid) ?? 0) + share,
      );
      jcsCompletedByWorker.set(
        wid,
        (jcsCompletedByWorker.get(wid) ?? 0) + 1,
      );
    }
  }

  // 8. Build per-worker rows. Include every active worker.
  const workerRows: WorkerSummary[] = [];
  for (const w of allWorkers) {
    const att = attByWorker.get(w.id);
    const deptCode = w.departmentCode ?? "";
    const dept = deptByCode.get(deptCode);
    const workingMinutes = workingMinsByWorker.get(w.id) ?? 0;
    const productionMinutes = Math.round(
      productionMinsByWorker.get(w.id) ?? 0,
    );
    const efficiencyPct =
      workingMinutes > 0
        ? Math.round((productionMinutes / workingMinutes) * 100)
        : 0;
    workerRows.push({
      workerId: w.id,
      empNo: w.empNo ?? "",
      name: w.name,
      departmentCode: deptCode,
      departmentName: dept?.name ?? deptCode,
      clockIn: att?.clockIn ?? null,
      clockOut: att?.clockOut ?? null,
      status: att?.status ?? (workingMinutes > 0 ? "PRESENT" : "ABSENT"),
      workingMinutes,
      productionMinutes,
      efficiencyPct,
      jobsCompleted: jcsCompletedByWorker.get(w.id) ?? 0,
    });
  }
  workerRows.sort((a, b) => {
    if (a.departmentCode !== b.departmentCode) {
      return a.departmentCode < b.departmentCode ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  // 9. Roll up by department. Production-only departments are surfaced
  //    first; admin/non-prod (if any) follow at the bottom.
  const deptRollup = new Map<
    string,
    { workerCount: number; workingMinutes: number; productionMinutes: number }
  >();
  for (const w of workerRows) {
    if (!w.departmentCode) continue;
    const cur = deptRollup.get(w.departmentCode) ?? {
      workerCount: 0,
      workingMinutes: 0,
      productionMinutes: 0,
    };
    cur.workerCount += 1;
    cur.workingMinutes += w.workingMinutes;
    cur.productionMinutes += w.productionMinutes;
    deptRollup.set(w.departmentCode, cur);
  }
  const departmentSummaries: DepartmentSummary[] = [];
  for (const d of departments) {
    const r = deptRollup.get(d.code);
    if (!r || r.workerCount === 0) continue; // skip empty depts
    const eff =
      r.workingMinutes > 0
        ? Math.round((r.productionMinutes / r.workingMinutes) * 100)
        : 0;
    departmentSummaries.push({
      code: d.code,
      name: d.name,
      shortName: d.shortName ?? d.code,
      workerCount: r.workerCount,
      workingMinutes: r.workingMinutes,
      productionMinutes: r.productionMinutes,
      efficiencyPct: eff,
      flagged: r.workingMinutes > 0 && eff < LOW_EFFICIENCY_THRESHOLD,
    });
  }
  // Production depts on top (highest worker count first), then non-prod.
  departmentSummaries.sort((a, b) => {
    const ap = deptByCode.get(a.code)?.isProduction ? 1 : 0;
    const bp = deptByCode.get(b.code)?.isProduction ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.workerCount - a.workerCount;
  });

  const totalWork = workerRows.reduce((s, w) => s + w.workingMinutes, 0);
  const totalProd = workerRows.reduce((s, w) => s + w.productionMinutes, 0);
  const totalJobs = workerRows.reduce((s, w) => s + w.jobsCompleted, 0);
  const presentCount = workerRows.filter((w) => w.workingMinutes > 0).length;

  return {
    date: dateYmd,
    generatedAtIso: new Date().toISOString(),
    totals: {
      presentCount,
      workerCount: workerRows.length,
      workingMinutes: totalWork,
      productionMinutes: totalProd,
      efficiencyPct:
        totalWork > 0 ? Math.round((totalProd / totalWork) * 100) : 0,
      jobsCompleted: totalJobs,
    },
    departments: departmentSummaries,
    workers: workerRows,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering — A4 portrait, print-optimised, no JS, no external assets.
// Color palette mirrors the dashboard (warm earth tones). All inline styles
// so email clients render it consistently.
// ---------------------------------------------------------------------------

function formatHours(mins: number): string {
  if (mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDateLong(ymd: string): string {
  // "2026-05-26" → "Tuesday, 26 May 2026"
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function effColor(pct: number): string {
  if (pct >= 80) return "#15803D"; // green
  if (pct >= 60) return "#A16207"; // amber
  return "#B91C1C"; // red
}

export function renderEfficiencyHtml(data: EfficiencyData): string {
  const { date, totals, departments, workers } = data;
  const longDate = formatDateLong(date);
  const overallColor = effColor(totals.efficiencyPct);

  const deptRows = departments
    .map((d) => {
      const color = effColor(d.efficiencyPct);
      const flagBadge = d.flagged
        ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;font-size:9pt;font-weight:700;color:#B91C1C;background:#FEE2E2;border-radius:3px;">LOW</span>`
        : "";
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #E5E1DC;font-weight:600;">${escapeHtml(d.shortName)}${flagBadge}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #E5E1DC;text-align:right;">${d.workerCount}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #E5E1DC;text-align:right;">${formatHours(d.workingMinutes)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #E5E1DC;text-align:right;">${formatHours(d.productionMinutes)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #E5E1DC;text-align:right;font-weight:700;color:${color};">${d.efficiencyPct}%</td>
      </tr>`;
    })
    .join("\n");

  // Group workers by department for clearer reading on the long table.
  const workerSections: string[] = [];
  let curDept = "";
  let buf: string[] = [];
  const flushDept = () => {
    if (buf.length === 0) return;
    workerSections.push(
      `<tr><td colspan="7" style="padding:8px 8px 4px;font-size:9pt;font-weight:700;color:#6B5C32;letter-spacing:1px;text-transform:uppercase;background:#F4EFE3;">${escapeHtml(curDept || "Unassigned")}</td></tr>${buf.join("\n")}`,
    );
    buf = [];
  };
  for (const w of workers) {
    if (w.departmentName !== curDept) {
      flushDept();
      curDept = w.departmentName;
    }
    const present = w.workingMinutes > 0;
    const statusColor = present ? "#15803D" : "#9CA3AF";
    const effC = present ? effColor(w.efficiencyPct) : "#9CA3AF";
    const clockStr =
      w.clockIn && w.clockOut
        ? `${w.clockIn} – ${w.clockOut}`
        : w.clockIn
          ? `${w.clockIn} – …`
          : "—";
    buf.push(`<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;">${escapeHtml(w.empNo)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;">${escapeHtml(w.name)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;color:${statusColor};">${escapeHtml(w.status)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;text-align:center;">${escapeHtml(clockStr)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;text-align:right;">${formatHours(w.workingMinutes)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;text-align:right;">${formatHours(w.productionMinutes)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #F0ECE9;font-size:9.5pt;text-align:right;font-weight:700;color:${effC};">${present ? w.efficiencyPct + "%" : "—"}</td>
    </tr>`);
  }
  flushDept();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Daily Efficiency Report — ${escapeHtml(longDate)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1F1D1B;
    background: #fff;
    font-size: 10pt;
    line-height: 1.45;
  }
  .page { max-width: 186mm; margin: 0 auto; padding: 0; }
  h1 { font-size: 18pt; margin: 0 0 4px; font-weight: 700; letter-spacing: -0.3px; }
  h2 { font-size: 12pt; margin: 18px 0 6px; font-weight: 700; color: #1F1D1B; letter-spacing: 0.5px; text-transform: uppercase; }
  .meta { font-size: 9.5pt; color: #6B7280; margin-bottom: 14px; }
  .summary {
    display: table; width: 100%; border-collapse: collapse;
    margin: 8px 0 12px;
  }
  .summary .cell {
    display: table-cell; width: 25%; padding: 10px 8px;
    border: 1px solid #E5E1DC; background: #FAF7F2;
    vertical-align: top;
  }
  .summary .lbl { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 1px; color: #6B5C32; }
  .summary .val { font-size: 18pt; font-weight: 700; margin-top: 2px; }
  .summary .sub { font-size: 9pt; color: #6B7280; margin-top: 2px; }
  table.data { width: 100%; border-collapse: collapse; }
  table.data thead th {
    background: #1F1D1B; color: #fff; font-size: 9pt; font-weight: 600;
    padding: 7px 8px; text-align: left; letter-spacing: 0.5px;
  }
  table.data tbody td { font-size: 10pt; }
  .footer { margin-top: 18px; font-size: 8.5pt; color: #9CA3AF; text-align: center; border-top: 1px solid #E5E1DC; padding-top: 8px; }
  @media print {
    .no-print { display: none; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h2 { page-break-after: avoid; }
    tr { page-break-inside: avoid; }
  }
  .print-bar { position: sticky; top: 0; background: #F4EFE3; padding: 8px 12px; border-bottom: 1px solid #E5E1DC; text-align: right; }
  .print-bar button { padding: 6px 14px; font-size: 10pt; border: 1px solid #1F1D1B; background: #1F1D1B; color: #fff; cursor: pointer; border-radius: 4px; }
</style>
</head>
<body>
<div class="print-bar no-print">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="page">
  <h1>Daily Efficiency Report</h1>
  <div class="meta">
    ${escapeHtml(longDate)} &nbsp;·&nbsp; Hookka Manufacturing ERP
  </div>

  <div class="summary">
    <div class="cell">
      <div class="lbl">Present</div>
      <div class="val">${totals.presentCount}</div>
      <div class="sub">of ${totals.workerCount} active workers</div>
    </div>
    <div class="cell">
      <div class="lbl">Work Hours</div>
      <div class="val">${formatHours(totals.workingMinutes)}</div>
      <div class="sub">total clocked</div>
    </div>
    <div class="cell">
      <div class="lbl">Production Hours</div>
      <div class="val">${formatHours(totals.productionMinutes)}</div>
      <div class="sub">${totals.jobsCompleted} job cards completed</div>
    </div>
    <div class="cell">
      <div class="lbl">Overall Efficiency</div>
      <div class="val" style="color:${overallColor};">${totals.efficiencyPct}%</div>
      <div class="sub">production / work</div>
    </div>
  </div>

  <h2>Department Efficiency</h2>
  <table class="data">
    <thead><tr>
      <th>Department</th>
      <th style="text-align:right;">Workers</th>
      <th style="text-align:right;">Work Hrs</th>
      <th style="text-align:right;">Prod Hrs</th>
      <th style="text-align:right;">Efficiency</th>
    </tr></thead>
    <tbody>
      ${deptRows || `<tr><td colspan="5" style="padding:14px;text-align:center;color:#9CA3AF;">No department activity recorded for this date.</td></tr>`}
    </tbody>
  </table>

  <h2>Employee Detail</h2>
  <table class="data">
    <thead><tr>
      <th>Emp No.</th>
      <th>Name</th>
      <th>Status</th>
      <th style="text-align:center;">Clock In / Out</th>
      <th style="text-align:right;">Work Hrs</th>
      <th style="text-align:right;">Prod Hrs</th>
      <th style="text-align:right;">Efficiency</th>
    </tr></thead>
    <tbody>
      ${workerSections.join("\n") || `<tr><td colspan="7" style="padding:14px;text-align:center;color:#9CA3AF;">No workers active for this date.</td></tr>`}
    </tbody>
  </table>

  <div class="footer">
    Generated ${escapeHtml(new Date(data.generatedAtIso).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }))} SGT &nbsp;·&nbsp;
    Low-efficiency threshold &lt; ${LOW_EFFICIENCY_THRESHOLD}%
  </div>
</div>
</body>
</html>`;
}

export function renderEfficiencyEmailText(data: EfficiencyData): string {
  const lines: string[] = [];
  lines.push(`Daily Efficiency Report — ${formatDateLong(data.date)}`);
  lines.push("");
  lines.push(`Present: ${data.totals.presentCount} / ${data.totals.workerCount}`);
  lines.push(`Work hours: ${formatHours(data.totals.workingMinutes)}`);
  lines.push(`Production hours: ${formatHours(data.totals.productionMinutes)}`);
  lines.push(`Overall efficiency: ${data.totals.efficiencyPct}%`);
  lines.push(`Job cards completed: ${data.totals.jobsCompleted}`);
  lines.push("");
  lines.push("Department efficiency:");
  for (const d of data.departments) {
    const flag = d.flagged ? " [LOW]" : "";
    lines.push(
      `  ${d.shortName.padEnd(10)} ${String(d.workerCount).padStart(3)} workers · ${formatHours(d.workingMinutes).padStart(7)} work · ${formatHours(d.productionMinutes).padStart(7)} prod · ${String(d.efficiencyPct).padStart(3)}%${flag}`,
    );
  }
  lines.push("");
  lines.push(
    "Open the HTML attachment or visit the Employees page → Reports tab for the full A4 layout.",
  );
  return lines.join("\n");
}
