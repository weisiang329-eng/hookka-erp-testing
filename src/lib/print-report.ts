// ---------------------------------------------------------------------------
// Shared "Print Report" helper for the Employees report tabs.
//
// Each report tab (Working Hours, Labor Cost, Efficiency Overview, Department
// Labor, Employee Performance, Payroll) has a "Print Report" button that
// prints EXACTLY what the operator is viewing — the current filter plus the
// on-screen rows. Rather than hit a server endpoint that ignores the filter,
// this builds a clean A4 HTML document in the browser from the rows the tab
// already computed, opens it in a new window, and triggers the print dialog
// (browser Print → Save as PDF / send to paper).
//
// Mirrors the proven client-side pattern in generate-payslip-pdf.ts
// (window.open → document.write → document.close → print), and reuses the
// same A4 print CSS feel so a printed report and a printed payslip look like
// one family of documents.
// ---------------------------------------------------------------------------

/** One printed column: a header label plus a value extractor for each row. */
export type PrintColumn = {
  /** Column header text. */
  header: string;
  /** Pull the cell value for a given row. Numbers are coerced to strings. */
  value: (row: unknown) => string | number;
  /** Cell + header alignment. Defaults to "left". */
  align?: "left" | "right" | "center";
};

export type PrintReportOptions = {
  /** Document title, e.g. "Working Hours" — shown big under the Hookka header. */
  title: string;
  /** Optional sub-line under the title (e.g. a department / category note). */
  subtitle?: string;
  /**
   * Small line describing the active filter, e.g.
   * "02/06/2026 – 05/06/2026 · All departments".
   */
  filterSummary: string;
  /** Column definitions, left-to-right. */
  columns: PrintColumn[];
  /** The on-screen rows to print, in display order. */
  rows: unknown[];
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

/**
 * Build the printable A4 HTML document for a report tab. Exported (not just
 * used internally) so it can be unit-tested without a DOM.
 */
export function buildReportHTML(opts: PrintReportOptions): string {
  const { title, subtitle, filterSummary, columns, rows } = opts;
  const printedAt = new Date().toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const headCells = columns
    .map(
      (col) =>
        `<th class="${col.align ?? "left"}">${escapeHtml(col.header)}</th>`,
    )
    .join("");

  const bodyRows =
    rows.length > 0
      ? rows
          .map((row) => {
            const cells = columns
              .map(
                (col) =>
                  `<td class="${col.align ?? "left"}">${escapeHtml(col.value(row))}</td>`,
              )
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("")
      : `<tr><td class="empty" colspan="${columns.length}">No rows to print for the current filter.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)} - Hookka</title>
  <style>
    @page { size: A4; margin: 14mm; }
    @media print { body { margin: 0; } }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1F1D1B; padding: 20px; }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 16px; }
    .header h1 { font-size: 18px; color: #000; margin-bottom: 2px; }
    .header p { font-size: 11px; color: #6B7280; }
    .header .title { font-size: 14px; font-weight: bold; margin-top: 8px; color: #1F1D1B; }
    .meta { margin-bottom: 14px; }
    .meta .subtitle { font-size: 12px; font-weight: 600; color: #1F1D1B; margin-bottom: 2px; }
    .meta .filter { font-size: 11px; color: #6B7280; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 10px; border-bottom: 1px solid #E2DDD8; }
    th { background: #f5f5f5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #000; border-bottom: 2px solid #000; }
    td { font-size: 12px; }
    th.left, td.left { text-align: left; }
    th.right, td.right { text-align: right; font-variant-numeric: tabular-nums; }
    th.center, td.center { text-align: center; }
    tbody tr:nth-child(even) td { background: #FAF9F7; }
    td.empty { text-align: center; color: #9CA3AF; padding: 24px 10px; }
    .footer { text-align: center; margin-top: 24px; padding-top: 12px; border-top: 1px solid #E2DDD8; font-size: 10px; color: #9CA3AF; }
  </style>
</head>
<body>
  <div class="header">
    <img src="/hookka-logo.png" alt="Hookka" style="height: 40px; width: auto; margin-bottom: 8px;" />
    <h1>HOOKKA INDUSTRIES SDN BHD</h1>
    <p>Co. Reg: 202301XXXXXX (XXXXXXX-X) | Lot XX, Jalan Perindustrian, 81700 Pasir Gudang, Johor</p>
    <div class="title">${escapeHtml(title.toUpperCase())}</div>
  </div>

  <div class="meta">
    ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
    <div class="filter">${escapeHtml(filterSummary)}</div>
  </div>

  <table>
    <thead><tr>${headCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>

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
