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

export function exportReportCsv(filename: string, aoa: Aoa): void {
  const csv = aoa.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  // BOM so Excel reads UTF-8 correctly.
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), filename);
}

export async function exportReportXlsx(filename: string, sheetName: string, aoa: Aoa): Promise<void> {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "Report");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

export async function exportReportPdf(
  filename: string,
  title: string,
  subtitle: string,
  aoa: Aoa,
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
  const head = aoa.length ? [aoa[0].map(String)] : [];
  const body = aoa.slice(1).map((r) => r.map(String));
  autoTable(doc, {
    head,
    body,
    startY: 76,
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [107, 92, 50], textColor: 255 },
    columnStyles: { 0: { halign: "left" } },
    didParseCell: (d: { column: { index: number }; cell: { styles: { halign: string } } }) => {
      if (d.column.index > 0) d.cell.styles.halign = "right";
    },
  });
  doc.save(filename);
}
