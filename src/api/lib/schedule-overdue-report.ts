// ---------------------------------------------------------------------------
// Production Schedule (today's plan) + Overdue (delayed items) reports.
//
// Both ride the same job-card → production-order → sales-order join with
// different date predicates:
//   - Schedule: jc.dueDate = TODAY  AND jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
//   - Overdue:  jc.dueDate < TODAY  AND jc.status NOT IN ('COMPLETED','TRANSFERRED')
//
// Rendered as A4 portrait HTML, one section per department. Same warm-earth
// palette as the efficiency report so the daily-mail trio reads as a set.
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

export interface ScheduleRow {
  jobCardId: string;
  departmentCode: string;
  departmentName: string;
  status: string;
  dueDate: string | null;
  productionOrderId: string;
  poNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  sizeLabel: string | null;
  wipLabel: string | null;
  quantity: number;
  pic1Name: string;
  pic2Name: string;
}

export interface OverdueRow extends ScheduleRow {
  daysOverdue: number;
}

export interface ScheduleReport {
  date: string;
  generatedAtIso: string;
  totals: { jobCards: number; departments: number; quantity: number };
  byDepartment: Array<{
    code: string;
    name: string;
    count: number;
    quantity: number;
    rows: ScheduleRow[];
  }>;
}

export interface OverdueReport {
  date: string;
  generatedAtIso: string;
  totals: { jobCards: number; departments: number; worstDays: number };
  byDepartment: Array<{
    code: string;
    name: string;
    count: number;
    worstDays: number;
    rows: OverdueRow[];
  }>;
}

type RawRow = {
  jobCardId: string;
  departmentCode: string | null;
  departmentName: string | null;
  status: string;
  dueDate: string | null;
  productionOrderId: string;
  poNo: string | null;
  customerName: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  wipLabel: string | null;
  quantity: number | null;
  pic1Name: string | null;
  pic2Name: string | null;
};

const RAW_SQL_BASE = `
  SELECT jc.id           AS jobCardId,
         jc.departmentCode,
         jc.departmentName,
         jc.status,
         jc.dueDate,
         jc.wipLabel,
         jc.pic1Name,
         jc.pic2Name,
         po.id            AS productionOrderId,
         po.poNo,
         po.customerName,
         po.productCode,
         po.productName,
         po.sizeLabel,
         po.quantity
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.productionOrderId`;

function mapRow(r: RawRow): ScheduleRow {
  return {
    jobCardId: r.jobCardId,
    departmentCode: r.departmentCode ?? "—",
    departmentName: r.departmentName ?? r.departmentCode ?? "—",
    status: r.status,
    dueDate: r.dueDate,
    productionOrderId: r.productionOrderId,
    poNo: r.poNo ?? "",
    customerName: r.customerName ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    sizeLabel: r.sizeLabel,
    wipLabel: r.wipLabel,
    quantity: r.quantity ?? 0,
    pic1Name: r.pic1Name ?? "",
    pic2Name: r.pic2Name ?? "",
  };
}

export async function collectScheduleData(
  db: DbLike,
  dateYmd: string,
): Promise<ScheduleReport> {
  const sql = `${RAW_SQL_BASE}
    WHERE jc.dueDate = ?
      AND jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
      AND po.status NOT IN ('CANCELLED','COMPLETED')
    ORDER BY jc.departmentCode, po.poNo, jc.sequence`;
  const res = await db.prepare(sql).bind(dateYmd).all<RawRow>();
  const rows = (res.results ?? []).map(mapRow);

  const byDept = new Map<string, ScheduleReport["byDepartment"][number]>();
  for (const r of rows) {
    const key = r.departmentCode;
    let cell = byDept.get(key);
    if (!cell) {
      cell = {
        code: key,
        name: r.departmentName,
        count: 0,
        quantity: 0,
        rows: [],
      };
      byDept.set(key, cell);
    }
    cell.count += 1;
    cell.quantity += r.quantity;
    cell.rows.push(r);
  }
  const byDepartment = Array.from(byDept.values()).sort((a, b) =>
    a.code.localeCompare(b.code),
  );
  return {
    date: dateYmd,
    generatedAtIso: new Date().toISOString(),
    totals: {
      jobCards: rows.length,
      departments: byDepartment.length,
      quantity: rows.reduce((s, r) => s + r.quantity, 0),
    },
    byDepartment,
  };
}

export async function collectOverdueData(
  db: DbLike,
  dateYmd: string,
): Promise<OverdueReport> {
  const sql = `${RAW_SQL_BASE}
    WHERE jc.dueDate < ?
      AND jc.dueDate IS NOT NULL
      AND jc.status NOT IN ('COMPLETED','TRANSFERRED')
      AND po.status NOT IN ('CANCELLED','COMPLETED')
    ORDER BY jc.dueDate ASC, jc.departmentCode, po.poNo`;
  const res = await db.prepare(sql).bind(dateYmd).all<RawRow>();
  const today = new Date(dateYmd + "T00:00:00Z").getTime();
  const rows: OverdueRow[] = (res.results ?? []).map((r) => {
    const base = mapRow(r);
    const due = base.dueDate
      ? new Date(base.dueDate + "T00:00:00Z").getTime()
      : today;
    const days = Math.max(0, Math.floor((today - due) / 86400000));
    return { ...base, daysOverdue: days };
  });

  const byDept = new Map<string, OverdueReport["byDepartment"][number]>();
  for (const r of rows) {
    const key = r.departmentCode;
    let cell = byDept.get(key);
    if (!cell) {
      cell = {
        code: key,
        name: r.departmentName,
        count: 0,
        worstDays: 0,
        rows: [],
      };
      byDept.set(key, cell);
    }
    cell.count += 1;
    if (r.daysOverdue > cell.worstDays) cell.worstDays = r.daysOverdue;
    cell.rows.push(r);
  }
  const byDepartment = Array.from(byDept.values()).sort((a, b) => {
    if (b.worstDays !== a.worstDays) return b.worstDays - a.worstDays;
    return a.code.localeCompare(b.code);
  });

  return {
    date: dateYmd,
    generatedAtIso: new Date().toISOString(),
    totals: {
      jobCards: rows.length,
      departments: byDepartment.length,
      worstDays: rows.reduce((m, r) => Math.max(m, r.daysOverdue), 0),
    },
    byDepartment,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering. Same A4 portrait layout / palette as the efficiency report.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateLong(ymd: string): string {
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

function statusColor(s: string): string {
  switch (s) {
    case "IN_PROGRESS":
      return "#1D4ED8";
    case "PAUSED":
      return "#A16207";
    case "BLOCKED":
      return "#B91C1C";
    case "WAITING":
      return "#6B7280";
    default:
      return "#1F1D1B";
  }
}

const PAGE_CSS = `
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1F1D1B;
    background: #fff;
    font-size: 9.5pt;
    line-height: 1.4;
  }
  .page { max-width: 186mm; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 4px; font-weight: 700; letter-spacing: -0.3px; }
  h2 { font-size: 11pt; margin: 16px 0 6px; font-weight: 700; color: #6B5C32; letter-spacing: 1px; text-transform: uppercase; page-break-after: avoid; }
  .meta { font-size: 9pt; color: #6B7280; margin-bottom: 12px; }
  .summary { display: table; width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
  .summary .cell { display: table-cell; width: 33.33%; padding: 8px 10px; border: 1px solid #E5E1DC; background: #FAF7F2; vertical-align: top; }
  .summary .lbl { font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; color: #6B5C32; }
  .summary .val { font-size: 18pt; font-weight: 700; margin-top: 2px; }
  .summary .sub { font-size: 8.5pt; color: #6B7280; margin-top: 2px; }
  .dept-card { border: 1px solid #E5E1DC; border-radius: 4px; margin-bottom: 12px; page-break-inside: avoid; }
  .dept-head { background: #1F1D1B; color: #fff; padding: 8px 12px; font-weight: 700; font-size: 10.5pt; }
  .dept-head .right { float: right; font-weight: 400; font-size: 9pt; color: #C5BEAE; }
  table.data { width: 100%; border-collapse: collapse; }
  table.data thead th { background: #F4EFE3; color: #1F1D1B; font-size: 8.5pt; font-weight: 700; padding: 5px 8px; text-align: left; letter-spacing: 0.4px; border-bottom: 1px solid #E5E1DC; }
  table.data tbody td { font-size: 9.5pt; padding: 5px 8px; border-bottom: 1px solid #F0ECE9; }
  table.data tbody tr:last-child td { border-bottom: 0; }
  .footer { margin-top: 18px; font-size: 8.5pt; color: #9CA3AF; text-align: center; border-top: 1px solid #E5E1DC; padding-top: 8px; }
  @media print { .no-print { display: none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  .print-bar { position: sticky; top: 0; background: #F4EFE3; padding: 8px 12px; border-bottom: 1px solid #E5E1DC; text-align: right; }
  .print-bar button { padding: 6px 14px; font-size: 10pt; border: 1px solid #1F1D1B; background: #1F1D1B; color: #fff; cursor: pointer; border-radius: 4px; }
`;

export function renderScheduleHtml(data: ScheduleReport): string {
  const { date, totals, byDepartment } = data;
  const longDate = formatDateLong(date);

  const deptSections = byDepartment
    .map((d) => {
      const rows = d.rows
        .map((r) => {
          const status = `<span style="color:${statusColor(r.status)};font-weight:600;">${escapeHtml(r.status)}</span>`;
          const pic = [r.pic1Name, r.pic2Name].filter(Boolean).join(", ");
          return `<tr>
            <td>${escapeHtml(r.poNo)}</td>
            <td>${escapeHtml(r.customerName)}</td>
            <td>${escapeHtml(r.productCode)}<br><span style="color:#6B7280;font-size:8.5pt;">${escapeHtml(r.productName)}</span></td>
            <td>${escapeHtml(r.sizeLabel ?? "")}</td>
            <td>${escapeHtml(r.wipLabel ?? "")}</td>
            <td style="text-align:right;">${r.quantity}</td>
            <td>${status}</td>
            <td>${escapeHtml(pic || "—")}</td>
          </tr>`;
        })
        .join("");
      return `<div class="dept-card">
        <div class="dept-head">
          ${escapeHtml(d.name)}
          <span class="right">${d.count} job cards · ${d.quantity} units</span>
        </div>
        <table class="data">
          <thead><tr>
            <th>PO No.</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Size</th>
            <th>Stage</th>
            <th style="text-align:right;">Qty</th>
            <th>Status</th>
            <th>PIC</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Production Schedule — ${escapeHtml(longDate)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="print-bar no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <h1>Production Schedule</h1>
  <div class="meta">${escapeHtml(longDate)} &nbsp;·&nbsp; Hookka Manufacturing ERP</div>
  <div class="summary">
    <div class="cell"><div class="lbl">Job Cards Today</div><div class="val">${totals.jobCards}</div><div class="sub">across ${totals.departments} departments</div></div>
    <div class="cell"><div class="lbl">Units</div><div class="val">${totals.quantity}</div><div class="sub">total planned</div></div>
    <div class="cell"><div class="lbl">Departments</div><div class="val">${totals.departments}</div><div class="sub">with work scheduled</div></div>
  </div>
  ${deptSections || `<p style="text-align:center;padding:30px;color:#9CA3AF;">No job cards scheduled for this date.</p>`}
  <div class="footer">Generated ${escapeHtml(new Date(data.generatedAtIso).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }))} SGT</div>
</div>
</body>
</html>`;
}

export function renderOverdueHtml(data: OverdueReport): string {
  const { date, totals, byDepartment } = data;
  const longDate = formatDateLong(date);

  const deptSections = byDepartment
    .map((d) => {
      const rows = d.rows
        .map((r) => {
          const daysColor =
            r.daysOverdue >= 7
              ? "#B91C1C"
              : r.daysOverdue >= 3
                ? "#A16207"
                : "#1F1D1B";
          const status = `<span style="color:${statusColor(r.status)};font-weight:600;">${escapeHtml(r.status)}</span>`;
          const pic = [r.pic1Name, r.pic2Name].filter(Boolean).join(", ");
          return `<tr>
            <td>${escapeHtml(r.poNo)}</td>
            <td>${escapeHtml(r.customerName)}</td>
            <td>${escapeHtml(r.productCode)}<br><span style="color:#6B7280;font-size:8.5pt;">${escapeHtml(r.productName)}</span></td>
            <td>${escapeHtml(r.dueDate ?? "")}</td>
            <td style="text-align:right;font-weight:700;color:${daysColor};">${r.daysOverdue}d</td>
            <td>${escapeHtml(r.wipLabel ?? "")}</td>
            <td style="text-align:right;">${r.quantity}</td>
            <td>${status}</td>
            <td>${escapeHtml(pic || "—")}</td>
          </tr>`;
        })
        .join("");
      const worstClr =
        d.worstDays >= 7
          ? "#B91C1C"
          : d.worstDays >= 3
            ? "#A16207"
            : "#C5BEAE";
      return `<div class="dept-card">
        <div class="dept-head">
          ${escapeHtml(d.name)}
          <span class="right">${d.count} overdue · worst <span style="color:${worstClr};font-weight:700;">${d.worstDays}d</span></span>
        </div>
        <table class="data">
          <thead><tr>
            <th>PO No.</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Due Date</th>
            <th style="text-align:right;">Overdue</th>
            <th>Stage</th>
            <th style="text-align:right;">Qty</th>
            <th>Status</th>
            <th>PIC</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("\n");

  const headerColor =
    totals.worstDays >= 7
      ? "#B91C1C"
      : totals.worstDays >= 3
        ? "#A16207"
        : "#1F1D1B";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Overdue Report — ${escapeHtml(longDate)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="print-bar no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <h1>Overdue Report</h1>
  <div class="meta">${escapeHtml(longDate)} &nbsp;·&nbsp; Hookka Manufacturing ERP</div>
  <div class="summary">
    <div class="cell"><div class="lbl">Overdue Job Cards</div><div class="val">${totals.jobCards}</div><div class="sub">past due date</div></div>
    <div class="cell"><div class="lbl">Departments Affected</div><div class="val">${totals.departments}</div><div class="sub">with backlog</div></div>
    <div class="cell"><div class="lbl">Worst Delay</div><div class="val" style="color:${headerColor};">${totals.worstDays}d</div><div class="sub">single oldest item</div></div>
  </div>
  ${deptSections || `<p style="text-align:center;padding:30px;color:#15803D;font-weight:600;">No overdue job cards — every department is on schedule.</p>`}
  <div class="footer">Generated ${escapeHtml(new Date(data.generatedAtIso).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }))} SGT</div>
</div>
</body>
</html>`;
}

export function renderScheduleEmailText(data: ScheduleReport): string {
  const lines: string[] = [];
  lines.push(`Production Schedule — ${formatDateLong(data.date)}`);
  lines.push("");
  lines.push(
    `${data.totals.jobCards} job cards · ${data.totals.quantity} units · ${data.totals.departments} departments`,
  );
  lines.push("");
  for (const d of data.byDepartment) {
    lines.push(`${d.name}: ${d.count} JC · ${d.quantity} units`);
  }
  if (data.byDepartment.length === 0) {
    lines.push("No job cards scheduled today.");
  }
  return lines.join("\n");
}

export function renderOverdueEmailText(data: OverdueReport): string {
  const lines: string[] = [];
  lines.push(`Overdue Report — ${formatDateLong(data.date)}`);
  lines.push("");
  lines.push(
    `${data.totals.jobCards} overdue job cards across ${data.totals.departments} departments · worst delay ${data.totals.worstDays} days`,
  );
  lines.push("");
  for (const d of data.byDepartment) {
    lines.push(`${d.name}: ${d.count} overdue · worst ${d.worstDays}d`);
  }
  if (data.byDepartment.length === 0) {
    lines.push("No overdue job cards — every department is on schedule.");
  }
  return lines.join("\n");
}
