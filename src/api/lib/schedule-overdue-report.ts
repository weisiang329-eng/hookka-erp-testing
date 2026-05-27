// ---------------------------------------------------------------------------
// Production Schedule (today's plan) + Overdue (delayed items) reports.
//
// Schedule — what every department should produce TODAY. Sourced from
// job_cards with dueDate = today AND status open. Grouped by department.
// One row per JC; shows estimated production minutes so the dept lead can
// prioritise.
//
// Overdue — what we PROMISED the customer but have not yet finished /
// delivered. Sourced from production_orders (one row per ordered product
// line, NOT per JC) where targetEndDate < today and status not terminal.
// Grouped by current bottleneck department. Each PO appears exactly once.
//
// Rendered as A4 LANDSCAPE HTML so the wide column set fits comfortably.
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

// ─── SCHEDULE ──────────────────────────────────────────────────────────────

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
  /** (actualMinutes ?? estMinutes) × wipQty — total for the JC, not per-unit. */
  prodMinutes: number;
  pic1Name: string;
  pic2Name: string;
}

export interface ScheduleReport {
  date: string;
  generatedAtIso: string;
  totals: {
    jobCards: number;
    departments: number;
    quantity: number;
    /** Sum of prodMinutes — total estimated production-floor time today. */
    prodMinutes: number;
  };
  byDepartment: Array<{
    code: string;
    name: string;
    count: number;
    quantity: number;
    prodMinutes: number;
    rows: ScheduleRow[];
  }>;
}

type ScheduleRawRow = {
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
  estMinutes: number | null;
  actualMinutes: number | null;
  wipQty: number | null;
  pic1Name: string | null;
  pic2Name: string | null;
};

function mapScheduleRow(r: ScheduleRawRow): ScheduleRow {
  const wipQty = Math.max(1, r.wipQty ?? 1);
  const perUnit = r.actualMinutes ?? r.estMinutes ?? 0;
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
    prodMinutes: Math.round(perUnit * wipQty),
    pic1Name: r.pic1Name ?? "",
    pic2Name: r.pic2Name ?? "",
  };
}

export async function collectScheduleData(
  db: DbLike,
  dateYmd: string,
): Promise<ScheduleReport> {
  const sql = `
    SELECT jc.id           AS jobCardId,
           jc.departmentCode, jc.departmentName, jc.status, jc.dueDate,
           jc.wipLabel, jc.pic1Name, jc.pic2Name,
           jc.estMinutes, jc.actualMinutes, jc.wipQty,
           po.id            AS productionOrderId,
           po.poNo, po.customerName, po.productCode, po.productName,
           po.sizeLabel, po.quantity
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.productionOrderId
     WHERE jc.dueDate = ?
       AND jc.status IN ('WAITING','IN_PROGRESS','PAUSED','BLOCKED')
       AND po.status NOT IN ('CANCELLED','COMPLETED')
     ORDER BY jc.departmentCode, po.poNo, jc.sequence`;
  const res = await db.prepare(sql).bind(dateYmd).all<ScheduleRawRow>();
  const rows = (res.results ?? []).map(mapScheduleRow);

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
        prodMinutes: 0,
        rows: [],
      };
      byDept.set(key, cell);
    }
    cell.count += 1;
    cell.quantity += r.quantity;
    cell.prodMinutes += r.prodMinutes;
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
      prodMinutes: rows.reduce((s, r) => s + r.prodMinutes, 0),
    },
    byDepartment,
  };
}

// ─── OVERDUE ───────────────────────────────────────────────────────────────
// Now sourced from production_orders directly (PO-level), not job_cards.
// Each PO appears once. "Should have been delivered but isn't" =
//   po.targetEndDate < today AND po.status NOT IN ('COMPLETED','CANCELLED').

export interface OverdueRow {
  productionOrderId: string;
  poNo: string;
  customerName: string;
  customerState: string;
  salesOrderNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  targetEndDate: string | null;
  status: string;
  currentDepartment: string;
  daysOverdue: number;
}

export interface OverdueReport {
  date: string;
  generatedAtIso: string;
  totals: {
    orderLines: number;
    departments: number;
    worstDays: number;
    quantity: number;
  };
  byDepartment: Array<{
    code: string;
    name: string;
    count: number;
    quantity: number;
    worstDays: number;
    rows: OverdueRow[];
  }>;
}

type OverdueRawRow = {
  id: string;
  poNo: string | null;
  customerName: string | null;
  customerState: string | null;
  salesOrderNo: string | null;
  productCode: string | null;
  productName: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number | null;
  targetEndDate: string | null;
  status: string;
  currentDepartment: string | null;
};

export async function collectOverdueData(
  db: DbLike,
  dateYmd: string,
): Promise<OverdueReport> {
  const sql = `
    SELECT id, poNo, customerName, customerState, salesOrderNo,
           productCode, productName, sizeLabel, fabricCode, quantity,
           targetEndDate, status, currentDepartment
      FROM production_orders
     WHERE targetEndDate < ?
       AND targetEndDate IS NOT NULL
       AND status NOT IN ('COMPLETED','CANCELLED')
     ORDER BY targetEndDate ASC, poNo`;
  const res = await db.prepare(sql).bind(dateYmd).all<OverdueRawRow>();
  const today = new Date(dateYmd + "T00:00:00Z").getTime();
  const rows: OverdueRow[] = (res.results ?? []).map((r) => {
    const due = r.targetEndDate
      ? new Date(r.targetEndDate + "T00:00:00Z").getTime()
      : today;
    const days = Math.max(0, Math.floor((today - due) / 86400000));
    return {
      productionOrderId: r.id,
      poNo: r.poNo ?? "",
      customerName: r.customerName ?? "",
      customerState: r.customerState ?? "",
      salesOrderNo: r.salesOrderNo ?? "",
      productCode: r.productCode ?? "",
      productName: r.productName ?? "",
      sizeLabel: r.sizeLabel,
      fabricCode: r.fabricCode,
      quantity: r.quantity ?? 0,
      targetEndDate: r.targetEndDate,
      status: r.status,
      currentDepartment: r.currentDepartment ?? "—",
      daysOverdue: days,
    };
  });

  const byDept = new Map<string, OverdueReport["byDepartment"][number]>();
  for (const r of rows) {
    const key = r.currentDepartment;
    let cell = byDept.get(key);
    if (!cell) {
      cell = {
        code: key,
        name: key === "—" ? "Not started" : key,
        count: 0,
        quantity: 0,
        worstDays: 0,
        rows: [],
      };
      byDept.set(key, cell);
    }
    cell.count += 1;
    cell.quantity += r.quantity;
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
      orderLines: rows.length,
      departments: byDepartment.length,
      worstDays: rows.reduce((m, r) => Math.max(m, r.daysOverdue), 0),
      quantity: rows.reduce((s, r) => s + r.quantity, 0),
    },
    byDepartment,
  };
}

// ─── HTML RENDERING ────────────────────────────────────────────────────────
// A4 LANDSCAPE so the wide column set fits without horizontal scroll.

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

function formatMinutes(mins: number): string {
  if (!mins || mins <= 0) return "—";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
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
    case "PENDING":
      return "#6B7280";
    case "ON_HOLD":
      return "#A16207";
    default:
      return "#1F1D1B";
  }
}

const PAGE_CSS = `
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1F1D1B;
    background: #fff;
    font-size: 9pt;
    line-height: 1.4;
  }
  .page { max-width: 273mm; margin: 0 auto; }
  h1 { font-size: 20pt; margin: 0 0 2px; font-weight: 700; letter-spacing: -0.4px; }
  h2 { font-size: 11pt; margin: 14px 0 5px; font-weight: 700; color: #6B5C32; letter-spacing: 1px; text-transform: uppercase; page-break-after: avoid; }
  .meta { font-size: 9pt; color: #6B7280; margin-bottom: 10px; }
  .summary { display: table; width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
  .summary .cell { display: table-cell; padding: 8px 10px; border: 1px solid #E5E1DC; background: #FAF7F2; vertical-align: top; }
  .summary .lbl { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1px; color: #6B5C32; }
  .summary .val { font-size: 17pt; font-weight: 700; margin-top: 0; line-height: 1.1; }
  .summary .sub { font-size: 8pt; color: #6B7280; margin-top: 2px; }
  .dept-card { border: 1px solid #E5E1DC; border-radius: 4px; margin-bottom: 10px; page-break-inside: avoid; }
  .dept-head { background: #1F1D1B; color: #fff; padding: 7px 12px; font-weight: 700; font-size: 10.5pt; display: flex; justify-content: space-between; align-items: center; }
  .dept-head .right { font-weight: 400; font-size: 9pt; color: #C5BEAE; }
  table.data { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.data thead th { background: #F4EFE3; color: #1F1D1B; font-size: 8pt; font-weight: 700; padding: 5px 6px; text-align: left; letter-spacing: 0.3px; border-bottom: 1px solid #E5E1DC; white-space: nowrap; }
  table.data tbody td { font-size: 9pt; padding: 5px 6px; border-bottom: 1px solid #F0ECE9; vertical-align: top; overflow: hidden; text-overflow: ellipsis; }
  table.data tbody tr:last-child td { border-bottom: 0; }
  .footer { margin-top: 14px; font-size: 8pt; color: #9CA3AF; text-align: center; border-top: 1px solid #E5E1DC; padding-top: 6px; }
  @media print { .no-print { display: none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  .print-bar { position: sticky; top: 0; background: #F4EFE3; padding: 8px 12px; border-bottom: 1px solid #E5E1DC; text-align: right; z-index: 10; }
  .print-bar button { padding: 6px 14px; font-size: 10pt; border: 1px solid #1F1D1B; background: #1F1D1B; color: #fff; cursor: pointer; border-radius: 4px; }
  .secondary { color: #6B7280; font-size: 8pt; }
  .num { font-variant-numeric: tabular-nums; }
`;

export function renderScheduleHtml(data: ScheduleReport): string {
  const { date, totals, byDepartment } = data;
  const longDate = formatDateLong(date);

  const colWidths = `
    <colgroup>
      <col style="width:8%"/>   <!-- PO No -->
      <col style="width:10%"/>  <!-- Customer -->
      <col style="width:24%"/>  <!-- Product -->
      <col style="width:6%"/>   <!-- Size -->
      <col style="width:22%"/>  <!-- Stage (wipLabel) -->
      <col style="width:5%"/>   <!-- Qty -->
      <col style="width:7%"/>   <!-- Prod Mins -->
      <col style="width:8%"/>   <!-- Status -->
      <col style="width:10%"/>  <!-- PIC -->
    </colgroup>`;

  const deptSections = byDepartment
    .map((d) => {
      const rows = d.rows
        .map((r) => {
          const status = `<span style="color:${statusColor(r.status)};font-weight:600;">${escapeHtml(r.status)}</span>`;
          const pic = [r.pic1Name, r.pic2Name].filter(Boolean).join(", ");
          return `<tr>
            <td>${escapeHtml(r.poNo)}</td>
            <td>${escapeHtml(r.customerName)}</td>
            <td>${escapeHtml(r.productCode)}<br><span class="secondary">${escapeHtml(r.productName)}</span></td>
            <td>${escapeHtml(r.sizeLabel ?? "")}</td>
            <td>${escapeHtml(r.wipLabel ?? "")}</td>
            <td class="num" style="text-align:right;">${r.quantity}</td>
            <td class="num" style="text-align:right;">${formatMinutes(r.prodMinutes)}</td>
            <td>${status}</td>
            <td>${escapeHtml(pic || "—")}</td>
          </tr>`;
        })
        .join("");
      return `<div class="dept-card">
        <div class="dept-head">
          <span>${escapeHtml(d.name)}</span>
          <span class="right">${d.count} job cards · ${d.quantity} units · ${formatMinutes(d.prodMinutes)} planned</span>
        </div>
        <table class="data">
          ${colWidths}
          <thead><tr>
            <th>PO No.</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Size</th>
            <th>Stage</th>
            <th style="text-align:right;">Qty</th>
            <th style="text-align:right;">Prod Mins</th>
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
    <div class="cell"><div class="lbl">Job Cards Today</div><div class="val num">${totals.jobCards}</div><div class="sub">across ${totals.departments} departments</div></div>
    <div class="cell"><div class="lbl">Units</div><div class="val num">${totals.quantity}</div><div class="sub">total planned</div></div>
    <div class="cell"><div class="lbl">Planned Time</div><div class="val num">${formatMinutes(totals.prodMinutes)}</div><div class="sub">sum of estimates</div></div>
    <div class="cell"><div class="lbl">Departments</div><div class="val num">${totals.departments}</div><div class="sub">with work scheduled</div></div>
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

  const colWidths = `
    <colgroup>
      <col style="width:8%"/>   <!-- PO No -->
      <col style="width:8%"/>   <!-- SO -->
      <col style="width:14%"/>  <!-- Customer -->
      <col style="width:22%"/>  <!-- Product -->
      <col style="width:6%"/>   <!-- Size -->
      <col style="width:8%"/>   <!-- Fabric -->
      <col style="width:5%"/>   <!-- Qty -->
      <col style="width:10%"/>  <!-- Promise -->
      <col style="width:9%"/>   <!-- Overdue days -->
      <col style="width:10%"/>  <!-- Status -->
    </colgroup>`;

  const deptSections = byDepartment
    .map((d) => {
      const rows = d.rows
        .map((r) => {
          const daysColor =
            r.daysOverdue >= 14
              ? "#B91C1C"
              : r.daysOverdue >= 7
                ? "#DC2626"
                : r.daysOverdue >= 3
                  ? "#A16207"
                  : "#1F1D1B";
          const status = `<span style="color:${statusColor(r.status)};font-weight:600;">${escapeHtml(r.status)}</span>`;
          return `<tr>
            <td>${escapeHtml(r.poNo)}</td>
            <td>${escapeHtml(r.salesOrderNo)}</td>
            <td>${escapeHtml(r.customerName)}${r.customerState ? `<br><span class="secondary">${escapeHtml(r.customerState)}</span>` : ""}</td>
            <td>${escapeHtml(r.productCode)}<br><span class="secondary">${escapeHtml(r.productName)}</span></td>
            <td>${escapeHtml(r.sizeLabel ?? "")}</td>
            <td>${escapeHtml(r.fabricCode ?? "")}</td>
            <td class="num" style="text-align:right;">${r.quantity}</td>
            <td class="num">${escapeHtml(r.targetEndDate ?? "")}</td>
            <td class="num" style="text-align:right;font-weight:700;color:${daysColor};">${r.daysOverdue}d</td>
            <td>${status}</td>
          </tr>`;
        })
        .join("");
      const worstClr =
        d.worstDays >= 14
          ? "#FCA5A5"
          : d.worstDays >= 7
            ? "#FDBA74"
            : d.worstDays >= 3
              ? "#FCD34D"
              : "#C5BEAE";
      return `<div class="dept-card">
        <div class="dept-head">
          <span>${escapeHtml(d.name)}</span>
          <span class="right">${d.count} orders · ${d.quantity} units · worst <span style="color:${worstClr};font-weight:700;">${d.worstDays}d</span></span>
        </div>
        <table class="data">
          ${colWidths}
          <thead><tr>
            <th>PO No.</th>
            <th>SO No.</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Size</th>
            <th>Fabric</th>
            <th style="text-align:right;">Qty</th>
            <th>Promise</th>
            <th style="text-align:right;">Overdue</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("\n");

  const headerColor =
    totals.worstDays >= 14
      ? "#B91C1C"
      : totals.worstDays >= 7
        ? "#DC2626"
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
  <div class="meta">${escapeHtml(longDate)} &nbsp;·&nbsp; Hookka Manufacturing ERP &nbsp;·&nbsp; promised but not yet finished</div>
  <div class="summary">
    <div class="cell"><div class="lbl">Overdue Orders</div><div class="val num">${totals.orderLines}</div><div class="sub">product lines past promise date</div></div>
    <div class="cell"><div class="lbl">Units Affected</div><div class="val num">${totals.quantity}</div><div class="sub">total pieces</div></div>
    <div class="cell"><div class="lbl">Worst Delay</div><div class="val num" style="color:${headerColor};">${totals.worstDays}d</div><div class="sub">single oldest item</div></div>
    <div class="cell"><div class="lbl">Departments Stuck</div><div class="val num">${totals.departments}</div><div class="sub">where the items currently sit</div></div>
  </div>
  ${deptSections || `<p style="text-align:center;padding:30px;color:#15803D;font-weight:600;">No overdue orders — every promise date is on schedule.</p>`}
  <div class="footer">Generated ${escapeHtml(new Date(data.generatedAtIso).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }))} SGT &nbsp;·&nbsp; one row = one ordered product line (PO), each shown once.</div>
</div>
</body>
</html>`;
}

export function renderScheduleEmailText(data: ScheduleReport): string {
  const lines: string[] = [];
  lines.push(`Production Schedule — ${formatDateLong(data.date)}`);
  lines.push("");
  lines.push(
    `${data.totals.jobCards} job cards · ${data.totals.quantity} units · ${formatMinutes(data.totals.prodMinutes)} planned · ${data.totals.departments} departments`,
  );
  lines.push("");
  for (const d of data.byDepartment) {
    lines.push(
      `${d.name}: ${d.count} JC · ${d.quantity} units · ${formatMinutes(d.prodMinutes)}`,
    );
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
    `${data.totals.orderLines} overdue order lines · ${data.totals.quantity} units · worst ${data.totals.worstDays}d · stuck in ${data.totals.departments} departments`,
  );
  lines.push("");
  for (const d of data.byDepartment) {
    lines.push(`${d.name}: ${d.count} orders · ${d.quantity} units · worst ${d.worstDays}d`);
  }
  if (data.byDepartment.length === 0) {
    lines.push("No overdue orders — every promise date is on schedule.");
  }
  return lines.join("\n");
}
