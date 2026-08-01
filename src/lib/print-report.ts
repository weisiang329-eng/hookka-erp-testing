// ---------------------------------------------------------------------------
// Shared "Print Report" engine for the Employees report tabs.
//
// Each report tab (Working Hours, Labor Cost, Efficiency Overview, Department
// Labor, Employee Performance, Department Performance, Payroll) has a "Print
// Report" button that prints EXACTLY what the operator is viewing — the current
// filter, sort, and on-screen rows. Rather than hit a server endpoint that
// ignores the filter, this builds a clean A4 HTML document in the browser and
// triggers the print dialog (browser Print → Save as PDF / send to paper).
//
// The visual language mirrors the Daily Efficiency Report
// (api/lib/efficiency-report.ts) — the operator's gold standard: a Hookka
// header, an optional row of KPI "dashboard" cards, one or more titled sections
// (each a table, optionally grouped), colour/bold/badge highlights per cell, and
// a per-report paper orientation. Callers can still pass the simple
// `columns` + `rows` form (rendered as a single untitled section) — kept for
// back-compat with tabs not yet redesigned.
// ---------------------------------------------------------------------------

/** A coloured pill drawn next to a cell value (e.g. "LOW", "Reconciled"). */
export type PrintBadge = {
  text: string;
  /** Text colour, e.g. "#B91C1C". */
  color: string;
  /** Background colour, e.g. "#FEE2E2". */
  bg: string;
};

/** A rich cell: text plus optional colour / bold / alignment / badge. */
export type PrintCellObject = {
  text: string | number;
  color?: string;
  bold?: boolean;
  align?: "left" | "right" | "center";
  badge?: PrintBadge;
};

/** A cell value: a bare string/number, or a rich {@link PrintCellObject}. */
export type PrintCellValue = string | number | PrintCellObject;

/** One printed column: a header label plus a value extractor for each row. */
export type PrintColumn = {
  /** Column header text. */
  header: string;
  /** Pull the cell value for a given row. May return a rich cell. */
  value: (row: unknown) => PrintCellValue;
  /** Cell + header alignment. Defaults to "left". */
  align?: "left" | "right" | "center";
  /** Optional fixed column width (e.g. "18%"). Give EVERY section the same
   *  widths and their columns line up down the whole page — without it each
   *  table auto-sizes independently (owner 2026-06-12: columns must align
   *  across sections). */
  width?: string;
};

/** A KPI "dashboard" card in the top summary strip. */
export type PrintCard = {
  /** Small uppercase label, e.g. "Total Payroll Cost". */
  label: string;
  /** Big value, e.g. "RM 62,775.52". */
  value: string | number;
  /** Optional small sub-line under the value. */
  sub?: string;
  /** Optional value colour, e.g. green for a positive remain. */
  color?: string;
};

/** A titled table section. Multiple sections stack down the page. */
export type PrintSection = {
  /** Optional section heading (uppercase H2). */
  title?: string;
  /** Optional small note under the heading. */
  note?: string;
  /** Column definitions, left-to-right. */
  columns: PrintColumn[];
  /** The rows to print, in display order. */
  rows: unknown[];
  /** Optional row grouping — returns a group label; rows are printed under a
   *  group header row whenever the label changes (rows must already be ordered
   *  by group). */
  groupBy?: (row: unknown) => string;
  /** Optional bold totals row appended at the bottom (one cell per column). */
  totalRow?: PrintCellValue[];
  /** Message shown when `rows` is empty. */
  emptyText?: string;
};

export type PrintReportOptions = {
  /** Document title, e.g. "Labor Cost" — shown under the Hookka header. */
  title: string;
  /** Optional sub-line under the title (e.g. a department / employee note). */
  subtitle?: string;
  /** Small line describing the active filter (period · category · etc.). */
  filterSummary: string;
  /** Paper orientation. Defaults to "portrait". Use "landscape" for wide tables. */
  orientation?: "portrait" | "landscape";
  /**
   * Tighten type + padding for column-heavy tables (owner 2026-08-01: the
   * 18-column Payroll sheet). Landscape A4 is ~1000px of usable width; past
   * roughly a dozen numeric columns the default 11px/9px-padding cells stop
   * fitting and the table either wraps or overflows the page. Use with
   * `orientation: "landscape"`. Ordinary reports should leave it off — smaller
   * type is a cost, only worth paying when the alternative is an unreadable row.
   */
  dense?: boolean;
  /** Optional KPI cards drawn as a dashboard strip above the sections. */
  cards?: PrintCard[];
  /** One or more titled sections. Preferred over `columns` + `rows`. */
  sections?: PrintSection[];
  /** Back-compat single-table form: a lone untitled section. */
  columns?: PrintColumn[];
  /** Back-compat single-table form: its rows. */
  rows?: unknown[];
};

/** Escape the five HTML-significant characters so cell text can't break the
 *  document or inject markup. Applied to every header + cell value. */
function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Normalise a cell value to an object so rendering is uniform. */
function asCell(v: PrintCellValue): PrintCellObject {
  return typeof v === "object" && v !== null ? v : { text: v };
}

/** Render one <td> (or <th>-like) cell with its colour / bold / badge. */
function renderCell(v: PrintCellValue, fallbackAlign: PrintColumn["align"]): string {
  const cell = asCell(v);
  const align = cell.align ?? fallbackAlign ?? "left";
  const styles = [`text-align:${align}`];
  if (cell.color) styles.push(`color:${cell.color}`);
  if (cell.bold) styles.push("font-weight:700");
  const badge = cell.badge
    ? `<span class="badge" style="color:${cell.badge.color};background:${cell.badge.bg};">${escapeHtml(cell.badge.text)}</span>`
    : "";
  return `<td class="${align}" style="${styles.join(";")}">${escapeHtml(cell.text)}${badge}</td>`;
}

/** Build the <table> HTML for one section. */
function renderSection(section: PrintSection): string {
  const { title, note, columns, rows, groupBy, totalRow, emptyText } = section;
  const colCount = columns.length;

  const headCells = columns
    .map((col) => `<th class="${col.align ?? "left"}"${col.width ? ` style="width:${escapeHtml(col.width)}"` : ""}>${escapeHtml(col.header)}</th>`)
    .join("");

  let body = "";
  if (rows.length === 0) {
    body = `<tr><td class="empty" colspan="${colCount}">${escapeHtml(emptyText ?? "No rows to print for the current filter.")}</td></tr>`;
  } else {
    let curGroup: string | null = null;
    for (const row of rows) {
      if (groupBy) {
        const g = groupBy(row);
        if (g !== curGroup) {
          curGroup = g;
          body += `<tr class="group"><td colspan="${colCount}">${escapeHtml(g || "Unassigned")}</td></tr>`;
        }
      }
      const cells = columns.map((col) => renderCell(col.value(row), col.align)).join("");
      body += `<tr>${cells}</tr>`;
    }
  }

  const foot = totalRow
    ? `<tr class="total">${totalRow
        .map((v, i) => renderCell(asCellBold(v), columns[i]?.align))
        .join("")}</tr>`
    : "";

  return `${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}
  <table>
    <thead><tr>${headCells}</tr></thead>
    <tbody>${body}${foot}</tbody>
  </table>`;
}

/** Force a totals-row cell bold (keeps any colour the caller set). */
function asCellBold(v: PrintCellValue): PrintCellObject {
  const c = asCell(v);
  return { ...c, bold: true };
}

/** Render the KPI dashboard strip. */
function renderCards(cards: PrintCard[]): string {
  const cells = cards
    .map(
      (c) => `<div class="card">
      <div class="lbl">${escapeHtml(c.label)}</div>
      <div class="val"${c.color ? ` style="color:${c.color}"` : ""}>${escapeHtml(c.value)}</div>
      ${c.sub ? `<div class="sub">${escapeHtml(c.sub)}</div>` : ""}
    </div>`,
    )
    .join("");
  return `<div class="cards">${cells}</div>`;
}

/**
 * Build the printable A4 HTML document. Exported (not just used internally) so
 * it can be unit-tested without a DOM.
 */
export function buildReportHTML(opts: PrintReportOptions): string {
  const { title, subtitle, filterSummary, cards } = opts;
  const orientation = opts.orientation === "landscape" ? "landscape" : "portrait";
  const dense = opts.dense === true;
  const printedAt = new Date().toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  // Prefer explicit sections; fall back to the single columns+rows form.
  const sections: PrintSection[] =
    opts.sections && opts.sections.length > 0
      ? opts.sections
      : opts.columns
        ? [{ columns: opts.columns, rows: opts.rows ?? [] }]
        : [];

  const sectionsHtml = sections.map(renderSection).join("\n");
  const cardsHtml = cards && cards.length > 0 ? renderCards(cards) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)} - Hookka</title>
  <style>
    @page { size: A4 ${orientation}; margin: 13mm; }
    @media print { body { margin: 0; } .card, tr { page-break-inside: avoid; } h2 { page-break-after: avoid; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    /* On SCREEN the page previews at the real paper width (A4 portrait ≈
       794px / landscape ≈ 1123px at 96dpi) so what you see is what prints —
       a portrait report no longer smears across a wide monitor. Print output
       is unchanged (@page + 100%-width tables reflow as before). */
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 11px; color: #1F1D1B; padding: 18px; -webkit-print-color-adjust: exact; print-color-adjust: exact; max-width: ${orientation === "landscape" ? "1123px" : "794px"}; margin: 0 auto; }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 14px; }
    .header img { height: 38px; width: auto; margin-bottom: 6px; }
    .header h1 { font-size: 17px; color: #000; margin-bottom: 2px; }
    .header p { font-size: 10px; color: #6B7280; }
    .header .title { font-size: 14px; font-weight: bold; margin-top: 8px; color: #1F1D1B; letter-spacing: 0.5px; text-transform: uppercase; }
    .meta { margin-bottom: 12px; }
    .meta .subtitle { font-size: 12px; font-weight: 600; color: #1F1D1B; margin-bottom: 2px; }
    .meta .filter { font-size: 10.5px; color: #6B7280; }
    .cards { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 16px; }
    .card { flex: 1 1 0; min-width: 120px; border: 1px solid #E5E1DC; background: #FAF7F2; padding: 9px 11px; border-radius: 4px; }
    .card .lbl { font-size: 8.5px; text-transform: uppercase; letter-spacing: 1px; color: #6B5C32; }
    .card .val { font-size: 17px; font-weight: 700; margin-top: 3px; }
    .card .sub { font-size: 9px; color: #6B7280; margin-top: 2px; }
    h2 { font-size: 12px; margin: 16px 0 6px; font-weight: 700; color: #1F1D1B; letter-spacing: 0.5px; text-transform: uppercase; }
    p.note { font-size: 10px; color: #6B7280; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
    /* Wrapping (owner 2026-08-01: 「很多都去2排…有些地方爆掉了」). The old rule
       was "overflow-wrap: anywhere" on EVERY cell, which lets the browser break
       inside a word — so a wide payroll table printed "RM 2,0 / 50.00",
       "−RM 78.8 / 5 (1d)", "DRA / FT" and a PCB header stacked as "P/C/B".
       A number split across two lines is not a formatting nit; it is unreadable
       on a payslip. So: headers and every non-text column NEVER break, and text
       columns break only at word boundaries. If a numeric column truly cannot
       fit, we would rather it push the layout (visible, fixable) than silently
       cut a figure in half. */
    th, td { padding: 5px 9px; border-bottom: 1px solid #E2DDD8; }
    th { background: #1F1D1B; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
    td { font-size: 11px; }
    ${dense ? `
    th, td { padding: 3px 5px; }
    th { font-size: 8.5px; letter-spacing: 0.2px; }
    td { font-size: 9.5px; }
    ` : ""}
    th.left, td.left { text-align: left; }
    td.left { overflow-wrap: break-word; }
    th.right, td.right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    th.center, td.center { text-align: center; white-space: nowrap; }
    tbody tr:nth-child(even) td { background: #FAF9F7; }
    tr.group td { background: #F4EFE3 !important; font-size: 9.5px; font-weight: 700; color: #6B5C32; letter-spacing: 1px; text-transform: uppercase; }
    tr.total td { border-top: 2px solid #000; border-bottom: none; font-weight: 700; background: #fff !important; }
    td.empty { text-align: center; color: #9CA3AF; padding: 22px 9px; }
    .badge { display: inline-block; margin-left: 6px; padding: 1px 6px; font-size: 9px; font-weight: 700; border-radius: 3px; vertical-align: middle; }
    .footer { text-align: center; margin-top: 22px; padding-top: 10px; border-top: 1px solid #E2DDD8; font-size: 9px; color: #9CA3AF; }
  </style>
</head>
<body>
  <div class="header">
    <img src="/hookka-logo.png" alt="Hookka" />
    <h1>HOOKKA INDUSTRIES SDN BHD</h1>
    <p>Co. Reg: 202301XXXXXX (XXXXXXX-X) | Lot XX, Jalan Perindustrian, 81700 Pasir Gudang, Johor</p>
    <div class="title">${escapeHtml(title)}</div>
  </div>

  <div class="meta">
    ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
    <div class="filter">${escapeHtml(filterSummary)}</div>
  </div>

  ${cardsHtml}
  ${sectionsHtml}

  <div class="footer">
    This is a computer-generated report.<br>
    Generated on ${escapeHtml(printedAt)}
  </div>
</body>
</html>`;
}

/**
 * Open a new browser window with the built report and trigger the print
 * dialog. Filter-aware: the caller passes the rows + filter summary that
 * reflect the tab's current on-screen state.
 */
export function printReport(opts: PrintReportOptions): void {
  const html = buildReportHTML(opts);
  const printWindow = window.open("", "_blank");
  if (!printWindow) return;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  // Give the new window time to lay out the document before invoking print().
  // Runs from a print-button click handler in a plain utility function — no
  // React lifecycle, so useTimeout doesn't apply.
  // eslint-disable-next-line no-restricted-syntax -- non-React utility called from event handler
  setTimeout(() => printWindow.print(), 500);
}
