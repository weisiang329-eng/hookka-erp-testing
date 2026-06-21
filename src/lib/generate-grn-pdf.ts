import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import {
  fmtDate,
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  PDF,
  splitCodeName,
} from "@/lib/pdf-utils";
import type { LetterheadInfo } from "@/lib/generate-purchase-order-pdf";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateGRNPdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  // Letterhead override: the GRN prints under the Purchase Company that bought
  // the goods (HOOKKA / OHANA / any sister co in the registry), while the
  // accounting entity stays HOOKKA ("borrow the letterhead"). HOOKKA when omitted.
  letterheadOverride?: LetterheadInfo,
  // returnDoc: hand back the built jsPDF instead of saving — lets the bulk
  // "Download PDF" action merge several GRNs into one file (see merge-pdf.ts).
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  // Align to the DO/SI family margin (14mm) so PO / PI / GRN frame identically.
  const margin = PDF.margin; // 14
  const cw = pageW - margin * 2;

  // --- Header (shared letterhead — single source of truth across all docs).
  // Logo skipped for sister companies so we don't mis-brand them. ---
  const isHookkaLetterhead = !letterheadOverride || letterheadOverride.code === "HOOKKA";
  const companyName = letterheadOverride?.name ?? COMPANY.HOOKKA.name;
  drawLetterhead(doc, {
    docTitle: "GOODS RECEIVED NOTE",
    docNo: data.grnNo ?? "-",
    docDate: fmtDate(data.date),
    logo: isHookkaLetterhead,
    companyInfo: letterheadOverride
      ? {
          name: letterheadOverride.name,
          regNo: letterheadOverride.regNo ?? "",
          tin: letterheadOverride.tin ?? "",
          address: letterheadOverride.address ?? "",
          phone: letterheadOverride.phone ?? "",
          email: letterheadOverride.email ?? "",
        }
      : undefined,
    company: letterheadOverride ? undefined : "HOOKKA",
  });
  doc.setTextColor(...PDF.ink);

  // --- Reference block (DO/SI lblVal two-column style) ---
  const labelW = 24;
  const lblVal = (
    x: number,
    yy: number,
    k: string,
    v: string,
    maxW: number,
  ): number => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.muted);
    doc.text(k, x, yy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    const lines = doc.splitTextToSize(v || "-", maxW);
    doc.text(lines, x + labelW, yy);
    return yy + Math.max(1, lines.length) * 4.3 + 0.8;
  };

  const leftX = margin;
  const leftMaxW = cw * 0.55 - labelW;
  let ly = 40;
  ly = lblVal(leftX, ly, "Supplier", data.supplierName ?? "-", leftMaxW);
  ly = lblVal(leftX, ly, "Address", data.supplierAddress ?? "-", leftMaxW);
  ly = lblVal(leftX, ly, "Contact", data.supplierContact ?? "-", leftMaxW);

  const rightX = pageW / 2 + 12;
  const rightMaxW = pageW - margin - rightX - labelW;
  let ry = 40;
  ry = lblVal(rightX, ry, "GRN No.", data.grnNo ?? "-", rightMaxW);
  ry = lblVal(rightX, ry, "Date", fmtDate(data.date), rightMaxW);
  ry = lblVal(rightX, ry, "PO Ref", data.poRef ?? "-", rightMaxW);
  ry = lblVal(rightX, ry, "Supplier DO No.", data.doRef ?? data.supplierDoNo ?? "-", rightMaxW);
  lblVal(rightX, ry, "Warehouse", data.warehouse ?? "-", rightMaxW);

  let y = Math.max(ly, ry) + 2;

  // --- Received Items (bronze section label, DO/SI house style) ---
  type GRNItem = {
    itemCode?: string;
    description?: string;
    poQty?: number;
    receivedQty?: number;
    rejectedQty?: number;
    acceptedQty?: number;
  };
  const items: GRNItem[] = data.items ?? [];
  y = drawSectionLabel(doc, `Received Items (${items.length} lines)`, y);

  const tableBody = items.map((item, idx) => {
    // PO-derived GRN lines inherit the PO's blank code + "CODE - DESCRIPTION"
    // name; recover the code so the Item Code column isn't empty.
    const { code, description } = splitCodeName(item.itemCode, item.description);
    return [
      String(idx + 1),
      code,
      description,
      String(item.poQty ?? 0),
      String(item.receivedQty ?? 0),
      String(item.rejectedQty ?? 0),
      String(item.acceptedQty ?? 0),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 16 },
    head: [[
      { content: "No", styles: { halign: "center" } },
      { content: "Item Code" },
      { content: "Description" },
      { content: "PO Qty", styles: { halign: "right" } },
      { content: "Received Qty", styles: { halign: "right" } },
      { content: "Rejected Qty", styles: { halign: "right" } },
      { content: "Accepted Qty", styles: { halign: "right" } },
    ]],
    body: tableBody,
    // DO/SI house theme: plain grid, white header with a black underline rule,
    // hairline body lines, dashed per-row separators.
    theme: "plain",
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: PDF.ink,
      lineColor: PDF.rule,
      lineWidth: 0,
      overflow: "linebreak",
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 8,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: PDF.ink,
      valign: "middle",
    },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 25 },
      2: { cellWidth: "auto" },
      3: { cellWidth: 22, halign: "right" },
      4: { cellWidth: 22, halign: "right" },
      5: { cellWidth: 22, halign: "right" },
      6: { cellWidth: 22, halign: "right", fontStyle: "bold" },
    },
    didDrawCell(d) {
      // Thin dashed separator under every item row (drawn once on the last
      // column) — the DO/SI per-row separator.
      if (d.section !== "body" || d.column.index !== 6) return;
      const yy = d.cell.y + d.cell.height;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.1);
      doc.setLineDashPattern([0.7, 0.7], 0);
      doc.line(margin, yy, pageW - margin, yy);
      doc.setLineDashPattern([], 0);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // --- Remarks ---
  if (data.remarks) {
    const remarkLines = doc.splitTextToSize(data.remarks, cw);
    const blockH = 6 + remarkLines.length * 3.6;
    if (y + blockH > pageH - 50) { doc.addPage(); y = 36; }
    y = drawSectionLabel(doc, "Remarks", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.ink);
    doc.text(remarkLines, margin, y);
    y += remarkLines.length * 3.6 + 6;
  }

  // --- Three Signature Lines ---
  if (y + 26 > pageH - 18) { doc.addPage(); y = 36; }
  const sigWidth = 50;
  const sigGap = (cw - sigWidth * 3) / 2;
  const sigPositions = [
    margin,
    margin + sigWidth + sigGap,
    margin + (sigWidth + sigGap) * 2,
  ];
  const sigLabels = ["Received By", "Checked By", "Approved By"];

  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 3; i++) {
    doc.line(sigPositions[i], y + 14, sigPositions[i] + sigWidth, y + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.ink);
    doc.text(sigLabels[i], sigPositions[i], y + 19);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.faint);
    doc.text("Name / Date / Stamp", sigPositions[i], y + 23.5);
  }

  // --- Footer (all pages — shared DO/SI footer) ---
  // HOOKKA prints via the shared drawDocFooter; sister-company letterheads
  // keep their OWN name in the footer line, drawn in the same hairline style.
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    if (isHookkaLetterhead) {
      drawDocFooter(doc, "HOOKKA");
    } else {
      const fy = pageH - 12;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.3);
      doc.line(margin, fy - 4, pageW - margin, fy - 4);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      doc.setTextColor(...PDF.faint);
      doc.text(
        `${companyName} · This is a computer-generated document; no signature required for system records.`,
        margin,
        fy,
      );
      doc.text(
        `Generated ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
        pageW - margin,
        fy,
        { align: "right" },
      );
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...PDF.faint);
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 16, { align: "right" });
  }

  if (opts?.returnDoc) return doc;
  doc.save(`${data.grnNo ?? "GRN"}.pdf`);
}

// Merge several Goods Received Notes into ONE downloadable PDF (GRN list →
// bulk "Download PDF"). Each GRN renders with the SAME layout as the single
// download, then merge-pdf stitches them into one file.
export async function generateCombinedGRNPdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: { data: any; letterhead?: LetterheadInfo }[],
  filename = "GRNs.pdf",
): Promise<void> {
  if (items.length === 0) return;
  const docs = items
    .map(({ data, letterhead }) => generateGRNPdf(data, letterhead, { returnDoc: true }))
    .filter((d): d is jsPDF => !!d);
  const { downloadMergedPdf } = await import("./merge-pdf");
  await downloadMergedPdf(docs, filename);
}
