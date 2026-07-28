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
import { jcMinutesTotal } from "../../lib/job-card-minutes";

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
    // jcMinutesTotal skips the ×wipQty for FAB_CUT (perUnit is already the
    // per-SET total there) and applies it for every other dept.
    prodMinutes: Math.round(jcMinutesTotal(perUnit, r)),
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
// SO-level. ONE row per SO that was promised but isn't yet finished.
// "Promised but not finished" =
//   so.customerDeliveryDate < today
//   AND so.status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','ON_HOLD')
// Excludes READY_TO_SHIP / SHIPPED / DELIVERED / INVOICED / CLOSED /
// CANCELLED. Wei Siang's rule: "只看还没做完的" — once production has
// signed off (READY_TO_SHIP) the overdue is a warehouse/delivery problem,
// not a production problem, and this report is for the production team.
// Flat list (no grouping), sorted by days overdue desc (worst first).

export interface OverdueRow {
  salesOrderId: string;
  companySOId: string;
  customerName: string;
  customerState: string;
  customerDeliveryDate: string;
  hookkaExpectedDD: string | null;
  status: string;
  itemCount: number;
  totalQty: number;
  totalSen: number;
  daysOverdue: number;
  /** First 3 distinct product codes joined with " · ". Plus "+N more" tail
   *  if there are more lines. Empty when the SO has zero items. */
  productSummary: string;
}

export interface OverdueReport {
  date: string;
  generatedAtIso: string;
  totals: {
    salesOrders: number;
    units: number;
    totalSen: number;
    worstDays: number;
  };
  rows: OverdueRow[];
}

type OverdueSoRawRow = {
  id: string;
  companySOId: string | null;
  customerName: string | null;
  customerState: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  status: string;
  totalSen: number | null;
};

type OverdueItemRawRow = {
  salesOrderId: string;
  productCode: string | null;
  productName: string | null;
  quantity: number | null;
  lineNo: number | null;
};

export async function collectOverdueData(
  db: DbLike,
  dateYmd: string,
): Promise<OverdueReport> {
  // Two-step query — the earlier correlated-subquery approach returned 0
  // items/qty in the deployed report because the column-rename adapter
  // didn't rewrite `salesOrderId` inside the subquery. Two clean queries
  // avoid that surprise:
  //   1. Pull the SO headers that qualify as overdue.
  //   2. Pull all items for those SOs in one batch (IN clause).
  // Then aggregate in JS — small dataset (open SOs are O(hundreds), not
  // thousands).
  const soSql = `
    SELECT id, companySOId, customerName, customerState,
           customerDeliveryDate, hookkaExpectedDD, status, totalSen
      FROM sales_orders
     WHERE customerDeliveryDate < ?
       AND customerDeliveryDate IS NOT NULL
       AND customerDeliveryDate <> ''
       AND status IN ('DRAFT','CONFIRMED','IN_PRODUCTION','ON_HOLD')
     ORDER BY customerDeliveryDate ASC`;
  const soRes = await db.prepare(soSql).bind(dateYmd).all<OverdueSoRawRow>();
  const candidateSos = soRes.results ?? [];

  // Cross-check REAL delivery (fix 2026-07-28). The status filter above trusts
  // the denormalized sales_orders.status, which goes STALE: an SO can be
  // physically delivered while its status is never advanced past IN_PRODUCTION
  // (e.g. SV-2606-002 — production CANCELLED, then delivered on an INVOICED DO;
  // status stayed IN_PRODUCTION and it leaked into this "still in production"
  // report). So drop any candidate whose goods have actually gone out: it has a
  // DELIVERED / INVOICED delivery order. Same DELIVERED/INVOICED signal the
  // delivered-cascade backfill uses. Two-step (headers then this filter) to
  // stay inside the minimal DbLike interface, like the items query below.
  const deliveredSoNos = new Set<string>();
  if (candidateSos.length > 0) {
    const soNos = candidateSos
      .map((s) => s.companySOId)
      .filter((n): n is string => !!n);
    if (soNos.length > 0) {
      const placeholders = soNos.map(() => "?").join(",");
      const delRes = await db
        .prepare(
          `SELECT DISTINCT di.salesOrderNo AS soNo
             FROM delivery_order_items di
             JOIN delivery_orders d ON d.id = di.deliveryOrderId
            WHERE d.status IN ('DELIVERED','INVOICED')
              AND di.salesOrderNo IN (${placeholders})`,
        )
        .bind(...soNos)
        .all<{ soNo: string | null }>();
      for (const r of delRes.results ?? []) {
        if (r.soNo) deliveredSoNos.add(r.soNo);
      }
    }
  }
  const sos = candidateSos.filter(
    (s) => !s.companySOId || !deliveredSoNos.has(s.companySOId),
  );

  // Items per SO. Single IN-list query if any SOs matched.
  const itemsBySoId = new Map<string, OverdueItemRawRow[]>();
  if (sos.length > 0) {
    const soIds = sos.map((s) => s.id);
    const placeholders = soIds.map(() => "?").join(",");
    const itemsRes = await db
      .prepare(
        `SELECT salesOrderId, productCode, productName, quantity, lineNo
           FROM sales_order_items
          WHERE salesOrderId IN (${placeholders})
          ORDER BY salesOrderId, lineNo`,
      )
      .bind(...soIds)
      .all<OverdueItemRawRow>();
    for (const item of itemsRes.results ?? []) {
      const arr = itemsBySoId.get(item.salesOrderId) ?? [];
      arr.push(item);
      itemsBySoId.set(item.salesOrderId, arr);
    }
  }

  const today = new Date(dateYmd + "T00:00:00Z").getTime();
  const rows: OverdueRow[] = sos.map((r) => {
    const dd = r.customerDeliveryDate ?? "";
    const due = dd
      ? new Date(dd.slice(0, 10) + "T00:00:00Z").getTime()
      : today;
    const days = Math.max(0, Math.floor((today - due) / 86400000));
    const myItems = itemsBySoId.get(r.id) ?? [];
    const itemCount = myItems.length;
    const totalQty = myItems.reduce((s, it) => s + (Number(it.quantity) || 0), 0);

    // Product summary — first 3 distinct codes, then "+N more". The
    // operator usually only needs to glance at what's in the SO; the SO
    // detail page is the click-through for the full list.
    const distinctCodes: string[] = [];
    const seen = new Set<string>();
    for (const it of myItems) {
      const code = (it.productCode ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      distinctCodes.push(code);
    }
    const SHOW = 3;
    const head = distinctCodes.slice(0, SHOW).join(" · ");
    const tail =
      distinctCodes.length > SHOW
        ? ` · +${distinctCodes.length - SHOW} more`
        : "";
    const productSummary = head + tail;

    return {
      salesOrderId: r.id,
      companySOId: r.companySOId ?? "",
      customerName: r.customerName ?? "",
      customerState: r.customerState ?? "",
      customerDeliveryDate: dd.slice(0, 10),
      hookkaExpectedDD: (r.hookkaExpectedDD ?? "").slice(0, 10) || null,
      status: r.status,
      itemCount,
      totalQty,
      totalSen: Number(r.totalSen) || 0,
      daysOverdue: days,
      productSummary,
    };
  });
  // Worst delay first — operator sees the biggest fires on top.
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);

  return {
    date: dateYmd,
    generatedAtIso: new Date().toISOString(),
    totals: {
      salesOrders: rows.length,
      units: rows.reduce((s, r) => s + r.totalQty, 0),
      totalSen: rows.reduce((s, r) => s + r.totalSen, 0),
      worstDays: rows.length > 0 ? rows[0].daysOverdue : 0,
    },
    rows,
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
  /* Landscape A4 content area = 297mm − 2×12mm margin = 273mm. On screen
     we mirror the print width so the operator can spot column overflow
     before hitting Print. */
  .page { max-width: 273mm; margin: 0 auto; padding: 14px 18px; }
  @media screen and (min-width: 1100px) { body { background: #F4EFE3; } .page { background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.08); margin: 14px auto 32px; } }
  h1 { font-size: 20pt; margin: 0 0 2px; font-weight: 700; letter-spacing: -0.4px; }
  h2 { font-size: 11pt; margin: 14px 0 5px; font-weight: 700; color: #6B5C32; letter-spacing: 1px; text-transform: uppercase; page-break-after: avoid; }
  .meta { font-size: 9pt; color: #6B7280; margin-bottom: 10px; }
  .summary { display: table; width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
  .summary .cell { display: table-cell; padding: 8px 10px; border: 1px solid #E5E1DC; background: #FAF7F2; vertical-align: top; }
  .summary .lbl { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1px; color: #6B5C32; }
  .summary .val { font-size: 17pt; font-weight: 700; margin-top: 0; line-height: 1.1; }
  .summary .sub { font-size: 8pt; color: #6B7280; margin-top: 2px; }
  /* Dept cards CAN split across pages — at 20-100 rows each they are
     usually bigger than half an A4 sheet, so forcing them whole leaves a
     huge gap on page 1 (first dept gets pushed to page 2). Rows
     themselves stay atomic via tr page-break-inside:avoid below.
     Header stays attached via page-break-after:avoid on dept-head. */
  .dept-card { border: 1px solid #E5E1DC; border-radius: 4px; margin-bottom: 10px; }
  tr { page-break-inside: avoid; }
  .dept-head { background: #1F1D1B; color: #fff; padding: 7px 12px; font-weight: 700; font-size: 10.5pt; display: flex; justify-content: space-between; align-items: center; page-break-after: avoid; }
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

function formatRM(sen: number): string {
  if (!sen || sen === 0) return "—";
  const rm = sen / 100;
  return "RM " + rm.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function renderOverdueHtml(data: OverdueReport): string {
  const { date, totals, rows } = data;
  const longDate = formatDateLong(date);

  // ONE row per SO. Department grouping dropped per Wei Siang's request —
  // operator only cares about which Sales Orders are past their customer
  // delivery date, not which dept currently holds them. Two date columns
  // surface BOTH the customer's requested date AND Hookka's internal
  // target (which is typically earlier by the per-category buffer).
  const colWidths = `
    <colgroup>
      <col style="width:9%"/>   <!-- SO No -->
      <col style="width:14%"/>  <!-- Customer (+ state) -->
      <col style="width:22%"/>  <!-- Products -->
      <col style="width:5%"/>   <!-- Items -->
      <col style="width:5%"/>   <!-- Qty -->
      <col style="width:9%"/>   <!-- Customer DD -->
      <col style="width:9%"/>   <!-- Hookka DD -->
      <col style="width:7%"/>   <!-- Overdue days -->
      <col style="width:10%"/>  <!-- Value -->
      <col style="width:10%"/>  <!-- Status -->
    </colgroup>`;

  const dataRows = rows
    .map((r) => {
      const daysColor =
        r.daysOverdue >= 30
          ? "#B91C1C"
          : r.daysOverdue >= 14
            ? "#DC2626"
            : r.daysOverdue >= 7
              ? "#EA580C"
              : r.daysOverdue >= 3
                ? "#A16207"
                : "#1F1D1B";
      const rowBg =
        r.daysOverdue >= 30
          ? "#FEF2F2"
          : r.daysOverdue >= 14
            ? "#FFF7ED"
            : "transparent";
      const status = `<span style="color:${statusColor(r.status)};font-weight:600;">${escapeHtml(r.status)}</span>`;
      return `<tr style="background:${rowBg};">
        <td><strong>${escapeHtml(r.companySOId || r.salesOrderId)}</strong></td>
        <td>${escapeHtml(r.customerName)}${r.customerState ? ` <span class="secondary">· ${escapeHtml(r.customerState)}</span>` : ""}</td>
        <td>${escapeHtml(r.productSummary || "—")}</td>
        <td class="num" style="text-align:right;">${r.itemCount}</td>
        <td class="num" style="text-align:right;">${r.totalQty}</td>
        <td class="num">${escapeHtml(r.customerDeliveryDate)}</td>
        <td class="num"><span class="secondary">${escapeHtml(r.hookkaExpectedDD ?? "—")}</span></td>
        <td class="num" style="text-align:right;font-weight:700;color:${daysColor};">${r.daysOverdue}d</td>
        <td class="num" style="text-align:right;">${escapeHtml(formatRM(r.totalSen))}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("");

  const headerColor =
    totals.worstDays >= 30
      ? "#B91C1C"
      : totals.worstDays >= 14
        ? "#DC2626"
        : totals.worstDays >= 7
          ? "#EA580C"
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
  <div class="meta">${escapeHtml(longDate)} &nbsp;·&nbsp; Hookka Manufacturing ERP &nbsp;·&nbsp; sales orders past customer delivery date</div>
  <div class="summary">
    <div class="cell"><div class="lbl">Overdue SOs</div><div class="val num">${totals.salesOrders}</div><div class="sub">past customer delivery date</div></div>
    <div class="cell"><div class="lbl">Units</div><div class="val num">${totals.units}</div><div class="sub">total pieces affected</div></div>
    <div class="cell"><div class="lbl">Total Value</div><div class="val num">${escapeHtml(formatRM(totals.totalSen))}</div><div class="sub">money tied up in delays</div></div>
    <div class="cell"><div class="lbl">Worst Delay</div><div class="val num" style="color:${headerColor};">${totals.worstDays}d</div><div class="sub">single oldest SO</div></div>
  </div>
  ${rows.length === 0
      ? `<p style="text-align:center;padding:30px;color:#15803D;font-weight:600;">No overdue sales orders — every customer delivery date is on schedule.</p>`
      : `<table class="data">
          ${colWidths}
          <thead><tr>
            <th>SO No.</th>
            <th>Customer</th>
            <th>Products</th>
            <th style="text-align:right;">Items</th>
            <th style="text-align:right;">Units</th>
            <th>Customer DD</th>
            <th>Our Target DD</th>
            <th style="text-align:right;">Overdue</th>
            <th style="text-align:right;">Value</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${dataRows}</tbody>
        </table>`}
  <div class="footer">Generated ${escapeHtml(new Date(data.generatedAtIso).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }))} SGT &nbsp;·&nbsp; Customer DD = what the customer asked for &nbsp;·&nbsp; Our Target DD = Hookka's internal target (DD minus per-category buffer) &nbsp;·&nbsp; Overdue is measured against Customer DD.</div>
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
    `${data.totals.salesOrders} overdue SOs · ${data.totals.units} units · worst ${data.totals.worstDays}d`,
  );
  lines.push("");
  for (const r of data.rows.slice(0, 15)) {
    lines.push(
      `${(r.companySOId || "").padEnd(14)} ${(r.customerName || "").slice(0, 24).padEnd(25)} promise=${r.customerDeliveryDate} overdue=${r.daysOverdue}d`,
    );
  }
  if (data.rows.length === 0) {
    lines.push(
      "No overdue sales orders — every customer delivery date is on schedule.",
    );
  } else if (data.rows.length > 15) {
    lines.push(
      `... (${data.rows.length - 15} more, open the HTML attachment for the full list)`,
    );
  }
  return lines.join("\n");
}
