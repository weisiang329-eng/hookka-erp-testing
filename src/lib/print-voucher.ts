// Shared one-page voucher renderer for the three accounting documents that
// print as a physical voucher: Payment Voucher (PV), Official Receipt (OR) and
// Journal Voucher (JV). The three tabs in src/pages/accounting/index.tsx map
// their already-loaded data → a VoucherSpec and call printVoucher(spec); this
// module owns the single inline-HTML + window.print() implementation so the
// layout stays identical across all three.
//
// Mirrors the existing browser-print pattern (printStmt in accounting/index):
//   const w = window.open("", "_blank"); w.document.write(html); w.print();
//
// Pure-ish: building the HTML string is side-effect-free (buildVoucherHtml);
// only printVoucher touches window. Money is integer sen — the caller passes a
// formatMoney(sen) (the app's formatCurrency) so this file never imports the
// money formatter and never does float math.

export type VoucherColumn = {
  label: string;
  /** Cell alignment; amounts are "right". Defaults to "left". */
  align?: "left" | "right";
};

export type VoucherLine = {
  /** One cell per column, already stringified by the caller. */
  cells: string[];
};

export type VoucherSignature = {
  label: string;
};

export type VoucherSpec = {
  /** Document title, e.g. "PAYMENT VOUCHER". */
  title: string;
  company: {
    name: string;
    addressLines: readonly string[];
    regNo: string;
    tin: string;
    phone: string;
    email: string;
  };
  docNo: string;
  date: string;
  /** Party row, e.g. label "Pay To" + name "<payee>". */
  partyLabel: string;
  partyName: string;
  columns: VoucherColumn[];
  lines: VoucherLine[];
  /** A note printed under the table, e.g. "Paid from: 310-0010 · Maybank". */
  footerNote?: string;
  /** Pre-formatted total cells aligned under `columns`; omit to skip the row. */
  totalCells?: string[];
  /** Amount in words (PV / OR only). */
  amountWords?: string;
  remarks?: string;
  signatures: VoucherSignature[];
  /** ISO date the document is printed on; shown in the footer. */
  printedOn: string;
};

// Minimal HTML-escape for any value interpolated into the voucher. Document
// fields (payee, descriptions, account names) are user-entered, so escape them
// to keep the printed page well-formed and injection-free.
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRow(cells: string[], columns: VoucherColumn[], tag: "td" | "th", extraCls = ""): string {
  return cells
    .map((c, i) => {
      const align = columns[i]?.align === "right" ? "right" : "left";
      const cls = `${extraCls} align-${align}`.trim();
      return `<${tag} class="${cls}">${escapeHtml(c)}</${tag}>`;
    })
    .join("");
}

const VOUCHER_STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4; margin: 16mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 12px; color: #1F1D1B; margin: 0; }
  .sheet { max-width: 720px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1F1D1B; padding-bottom: 10px; }
  .co-name { font-size: 17px; font-weight: 700; letter-spacing: 0.3px; }
  .co-meta { font-size: 10.5px; color: #555; line-height: 1.5; margin-top: 3px; }
  .title { text-align: right; }
  .title h1 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: 1px; }
  .doc-meta { font-size: 11px; color: #333; margin-top: 6px; line-height: 1.6; }
  .doc-meta b { color: #1F1D1B; }
  .party { margin: 14px 0 10px; font-size: 12.5px; }
  .party b { font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th { background: #F5F2ED; border-top: 1px solid #C9C2B8; border-bottom: 1px solid #C9C2B8; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  td { border-bottom: 1px solid #E6E1DA; padding: 6px 8px; font-size: 12px; vertical-align: top; }
  .align-left { text-align: left; }
  .align-right { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td { border-top: 2px solid #1F1D1B; border-bottom: none; }
  .total-cell { font-weight: 700; padding-top: 8px; }
  .footer-note { margin-top: 8px; font-size: 11.5px; color: #333; }
  .words { margin-top: 12px; font-size: 12px; padding: 8px 10px; background: #FAF8F5; border: 1px solid #ECE7E0; border-radius: 4px; }
  .words-label, .remarks-label { font-weight: 600; }
  .remarks { margin-top: 10px; font-size: 11.5px; color: #333; }
  .sigs { display: flex; justify-content: space-between; gap: 24px; margin-top: 54px; }
  .sig { flex: 1; text-align: center; }
  .sig-line { border-top: 1px solid #1F1D1B; margin-bottom: 5px; }
  .sig-label { font-size: 11px; color: #444; }
  .printed { margin-top: 28px; text-align: right; font-size: 9.5px; color: #999; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  .sheet { page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
`;

/**
 * Build the inner .sheet HTML for a single voucher (no <html>/<head>/<body>
 * wrapper). Pure: no window/DOM access. Used by buildVoucherHtml and
 * buildVouchersDocument.
 */
export function buildVoucherSheet(spec: VoucherSpec): string {
  const co = spec.company;
  const addr = co.addressLines.map((l) => escapeHtml(l)).join("<br/>");

  const headRow = `<tr>${renderRow(spec.columns.map((c) => c.label), spec.columns, "th")}</tr>`;
  const bodyRows = spec.lines
    .map((ln) => `<tr>${renderRow(ln.cells, spec.columns, "td")}</tr>`)
    .join("");
  const totalRow = spec.totalCells
    ? `<tr class="total-row">${renderRow(spec.totalCells, spec.columns, "td", "total-cell")}</tr>`
    : "";

  const footerNote = spec.footerNote
    ? `<div class="footer-note">${escapeHtml(spec.footerNote)}</div>`
    : "";

  const wordsBlock = spec.amountWords
    ? `<div class="words"><span class="words-label">Amount in words:</span> ${escapeHtml(spec.amountWords)}</div>`
    : "";

  const remarksBlock = spec.remarks
    ? `<div class="remarks"><span class="remarks-label">Remarks:</span> ${escapeHtml(spec.remarks)}</div>`
    : "";

  const sigCols = spec.signatures
    .map(
      (s) =>
        `<div class="sig"><div class="sig-line"></div><div class="sig-label">${escapeHtml(s.label)}</div></div>`,
    )
    .join("");

  return `<div class="sheet">
  <div class="head">
    <div>
      <div class="co-name">${escapeHtml(co.name)}</div>
      <div class="co-meta">${addr}<br/>Reg No: ${escapeHtml(co.regNo)} &nbsp;|&nbsp; TIN: ${escapeHtml(co.tin)}<br/>Tel: ${escapeHtml(co.phone)} &nbsp;|&nbsp; ${escapeHtml(co.email)}</div>
    </div>
    <div class="title">
      <h1>${escapeHtml(spec.title)}</h1>
      <div class="doc-meta"><b>No:</b> ${escapeHtml(spec.docNo)}<br/><b>Date:</b> ${escapeHtml(spec.date)}</div>
    </div>
  </div>
  <div class="party"><b>${escapeHtml(spec.partyLabel)}:</b> ${escapeHtml(spec.partyName || "—")}</div>
  <table>
    <thead>${headRow}</thead>
    <tbody>${bodyRows}${totalRow}</tbody>
  </table>
  ${footerNote}
  ${wordsBlock}
  ${remarksBlock}
  <div class="sigs">${sigCols}</div>
  <div class="printed">Printed on ${escapeHtml(spec.printedOn)}</div>
</div>`;
}

/**
 * Build the full standalone HTML document for a voucher. Pure: no window/DOM
 * access, so it can be unit-tested. printVoucher() wraps this with the
 * window.open/print side effects.
 */
export function buildVoucherHtml(spec: VoucherSpec): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${escapeHtml(spec.title)} — ${escapeHtml(spec.docNo)}</title>
<style>${VOUCHER_STYLES}</style></head>
<body>${buildVoucherSheet(spec)}</body></html>`;
}

// One standalone HTML document holding N vouchers, each on its own A4 page.
export function buildVouchersDocument(specs: VoucherSpec[]): string {
  const title = specs.length === 1 ? `${escapeHtml(specs[0].title)} — ${escapeHtml(specs[0].docNo)}` : `Vouchers (${specs.length})`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>${title}</title>
<style>${VOUCHER_STYLES}</style></head>
<body>${specs.map(buildVoucherSheet).join("")}</body></html>`;
}

// Open a window with all the vouchers and trigger the print dialog
// (print to paper, or "Save as PDF"). Mirrors printVoucher().
export function printVouchers(specs: VoucherSpec[]): void {
  if (specs.length === 0) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(buildVouchersDocument(specs));
  w.document.close();
  w.focus();
  w.print();
}

/**
 * Open a new window, write the voucher HTML and trigger the browser print
 * dialog — the established pattern in this codebase (see printStmt).
 */
export function printVoucher(spec: VoucherSpec): void { printVouchers([spec]); }
