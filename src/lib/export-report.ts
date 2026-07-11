// ---------------------------------------------------------------------------
// Shared report export — CSV / XLSX / PDF from a simple array-of-arrays
// (header row + body rows). Used by the Phase-5 finance reports (P&L,
// Monthly Trend, Cost Structure, Cost/Expense classes, Balance Sheet).
//
// jspdf (~1MB) and xlsx are dynamic-imported inside each function so they
// stay out of the main bundle — the cost is paid only when the operator
// actually clicks an export button (same pattern as generate-order-pdf).
// ---------------------------------------------------------------------------

export type Aoa = (string | number)[][];

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportReportCsv(
  filename: string,
  aoa: Aoa,
  opts?: { moneyFormat?: boolean },
): void {
  // moneyFormat: fix numbers to 2 dp (1392.5 → 1392.50). No thousands
  // separator in CSV — commas are column delimiters; Excel formats on open.
  const cell = (v: string | number): string | number =>
    opts?.moneyFormat && typeof v === "number" ? v.toFixed(2) : v;
  const csv = aoa.map((r) => r.map((v) => csvEscape(cell(v))).join(",")).join("\r\n");
  // BOM so Excel reads UTF-8 correctly.
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), filename);
}

export async function exportReportXlsx(
  filename: string,
  sheetName: string,
  aoa: Aoa,
  opts?: { moneyFormat?: boolean },
): Promise<void> {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (opts?.moneyFormat) {
    // Give every numeric cell the accounting display format (1,392.50) —
    // still a real number underneath, so SUM/filter keep working.
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as { t?: string; z?: string } | undefined;
        if (cell && cell.t === "n") cell.z = "#,##0.00";
      }
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "Report");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

// Optional per-row styling for the PDF (owner 2026-07-09: doc rows and
// subtotal rows looked identical, party sections had no visible boundary).
export type PdfRowKind = "section" | "subtotal" | "grand" | undefined;
export type PdfExportOpts = {
  /** Format numeric cells as 1,392.50 (default true — these are money reports). */
  formatNumbers?: boolean;
  /** Classify a BODY row (raw values, body index) for banded styling. */
  rowKind?: (row: (string | number)[], idx: number) => PdfRowKind;
  /** Column indexes that hold TEXT (left-aligned). Default: only column 0 —
   *  every other column right-aligns, which is wrong for Doc No / Date. */
  leftCols?: number[];
  /** Fixed column widths in pt (landscape A4 ≈ 762pt usable). Unlisted
   *  columns keep autotable's auto width. */
  colWidths?: Record<number, number>;
};

export async function exportReportPdf(
  filename: string,
  title: string,
  subtitle: string,
  aoa: Aoa,
  opts?: PdfExportOpts,
): Promise<void> {
  const [{ default: jsPDF }, autoTableMod] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = (autoTableMod as unknown as { default: (doc: unknown, opts: unknown) => void }).default;
  // Landscape for the wide month-column reports.
  const doc = new jsPDF({ orientation: aoa[0] && aoa[0].length > 6 ? "landscape" : "portrait", unit: "pt", format: "a4" });
  doc.setFontSize(13);
  doc.text("HOOKKA MANUFACTURING SDN BHD", 40, 38);
  doc.setFontSize(10);
  doc.text(title, 40, 54);
  if (subtitle) { doc.setFontSize(8); doc.setTextColor(120); doc.text(subtitle, 40, 67); doc.setTextColor(0); }
  const useFmt = opts?.formatNumbers !== false;
  const fmtCell = (v: string | number): string =>
    useFmt && typeof v === "number"
      ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(v);
  const head = aoa.length ? [aoa[0].map(String)] : [];
  const rawBody = aoa.slice(1);
  const body = rawBody.map((r) => r.map(fmtCell));
  const kinds: PdfRowKind[] = opts?.rowKind ? rawBody.map((r, i) => opts.rowKind!(r, i)) : [];
  const leftCols = new Set([0, ...(opts?.leftCols ?? [])]);
  const columnStyles: Record<number, { halign?: string; cellWidth?: number }> = {};
  for (const c of leftCols) columnStyles[c] = { halign: "left" };
  for (const [c, w] of Object.entries(opts?.colWidths ?? {})) {
    columnStyles[Number(c)] = { ...columnStyles[Number(c)], cellWidth: w };
  }
  autoTable(doc, {
    head,
    body,
    startY: 76,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [107, 92, 50], textColor: 255 },
    columnStyles,
    didParseCell: (d: {
      section: string;
      row: { index: number };
      column: { index: number };
      cell: { styles: { halign: string; fillColor?: number[] | number; textColor?: number[] | number; fontStyle?: string } };
    }) => {
      if (!leftCols.has(d.column.index)) d.cell.styles.halign = "right";
      if (d.section !== "body") return;
      const k = kinds[d.row.index];
      if (k === "section") {
        d.cell.styles.fillColor = [226, 221, 216];
        d.cell.styles.fontStyle = "bold";
      } else if (k === "subtotal") {
        d.cell.styles.fillColor = [240, 236, 233];
        d.cell.styles.fontStyle = "bold";
      } else if (k === "grand") {
        d.cell.styles.fillColor = [107, 92, 50];
        d.cell.styles.textColor = 255;
        d.cell.styles.fontStyle = "bold";
      }
    },
  });
  doc.save(filename);
}
