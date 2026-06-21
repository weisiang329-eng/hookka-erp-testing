import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  fmtCurrency,
  fmtRM,
  fmtDate,
  amountInWords,
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  PDF,
  splitCodeName,
} from "@/lib/pdf-utils";
import { COMPANY } from "@/lib/constants";
import type { LetterheadInfo } from "@/lib/generate-purchase-order-pdf";

// ---------------------------------------------------------------------------
// Purchase Invoice (supplier invoice) PDF.
//
// The AP twin of the Purchase Order PDF — same letterhead-aware A4 layout, so
// PO / PI / GRN print as a consistent document family. This is OUR record of
// the supplier's invoice (the buyer/payer is HOOKKA), so it carries the HOOKKA
// letterhead by default; a sister-company letterhead can be passed in.
//
// Data shape mirrors what GET /api/purchase-invoices/:id returns (see
// src/pages/procurement/PurchaseInvoiceDetail.tsx) — kept local + loose so the
// PDF caller doesn't drag a canonical type around.
// ---------------------------------------------------------------------------
export type PurchaseInvoicePdfLine = {
  materialCode?: string | null;
  materialName: string;
  supplierSku?: string | null;
  qty: number;
  unitPriceSen: number;
  lineTotalSen: number;
  lineType?: string | null;
};

export type PurchaseInvoicePdfData = {
  piNo: string;
  poRef?: string;
  purchaseOrderId?: string;
  supplierId?: string;
  supplierName: string;
  invoiceDate?: string;
  dueDate?: string;
  amountSen: number;
  status: string;
  remarks?: string;
  items?: PurchaseInvoicePdfLine[];
  // Supplier reference numbers (mig 0183). The API returns snake_case;
  // the FE passes the raw response, so dual-key both spellings.
  supplierInvoiceNo?: string | null;
  supplier_invoice_no?: string | null;
  supplierDoNo?: string | null;
  supplier_do_no?: string | null;
  // Computed subtotal when available (sum of line totals). Falls back to amountSen.
  subtotalSen?: number;
};

function defaultLetterhead(): LetterheadInfo {
  return {
    code: "HOOKKA",
    name: COMPANY.HOOKKA.name,
    tagline: "Manufacturer of Premium Upholstered Furniture",
    phone: COMPANY.HOOKKA.phone,
    email: COMPANY.HOOKKA.email,
    regNo: COMPANY.HOOKKA.regNo,
    tin: COMPANY.HOOKKA.tin,
    address: COMPANY.HOOKKA.address,
  };
}

export function generatePurchaseInvoicePdf(
  pi: PurchaseInvoicePdfData,
  letterheadOverride?: LetterheadInfo,
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  const co = letterheadOverride ?? defaultLetterhead();
  const isHookkaLetterhead = co.code === "HOOKKA";

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  // Align to the DO/SI family margin (14mm) so PO / PI / GRN frame identically.
  const margin = PDF.margin; // 14
  const cw = pageW - margin * 2;

  // --- Header (shared letterhead — single source of truth across all docs).
  // Logo is skipped for sister companies so we don't mis-brand OHANA/HOUZS. ---
  drawLetterhead(doc, {
    docTitle: "PURCHASE INVOICE",
    docNo: pi.piNo,
    docDate: fmtDate(pi.invoiceDate),
    statusText: pi.status.replace(/_/g, " "),
    logo: isHookkaLetterhead,
    companyInfo: {
      name: co.name,
      regNo: co.regNo ?? "",
      tin: co.tin ?? "",
      address: co.address ?? "",
      phone: co.phone ?? "",
      email: co.email ?? "",
    },
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
  ly = lblVal(leftX, ly, "Supplier", pi.supplierName, leftMaxW);
  ly = lblVal(leftX, ly, "Supplier ID", pi.supplierId || "-", leftMaxW);

  const rightX = pageW / 2 + 12;
  const rightMaxW = pageW - margin - rightX - labelW;
  // Dual-key supplier reference numbers (API returns snake_case; toCamel
  // converts on some paths — accept both spellings, same as the GRN).
  const supplierInvoiceNo =
    (pi.supplierInvoiceNo ?? pi.supplier_invoice_no ?? "").trim() || "-";
  const supplierDoNo =
    (pi.supplierDoNo ?? pi.supplier_do_no ?? "").trim() || "-";
  let ry = 40;
  ry = lblVal(rightX, ry, "PI No.", pi.piNo || "-", rightMaxW);
  ry = lblVal(rightX, ry, "Supplier Invoice No.", supplierInvoiceNo, rightMaxW);
  ry = lblVal(rightX, ry, "Supplier DO No.", supplierDoNo, rightMaxW);
  ry = lblVal(rightX, ry, "Linked PO", pi.poRef || (pi.purchaseOrderId ? pi.purchaseOrderId : "-"), rightMaxW);
  ry = lblVal(rightX, ry, "Invoice Date", fmtDate(pi.invoiceDate), rightMaxW);
  ry = lblVal(rightX, ry, "Due Date", fmtDate(pi.dueDate), rightMaxW);
  lblVal(rightX, ry, "Status", pi.status.replace(/_/g, " "), rightMaxW);

  let y = Math.max(ly, ry) + 2;

  // --- Items (bronze section label, DO/SI house style) ---
  const items = pi.items ?? [];
  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  y = drawSectionLabel(doc, `Invoice Items (${items.length} lines, ${totalQty} qty)`, y);

  // Item Code column shows the material code for STOCKED lines, else the
  // line-type tag (FEE / TAX / REBATE / …) so non-stock charges read clearly.
  const tableBody = items.map((item, idx) => {
    const lt = (item.lineType || "STOCKED").toUpperCase();
    let code: string;
    let description: string;
    if (lt === "STOCKED") {
      // Real material_code wins; for PO-sourced lines with a blank code +
      // "CODE - DESCRIPTION" name, recover the code by splitting.
      const s = splitCodeName(item.materialCode, item.materialName);
      code = s.code || "-";
      description = s.description;
    } else {
      // Non-stock charge (FEE / TAX / REBATE …): the tag is the "code".
      code = lt;
      description = item.materialName;
    }
    return [
      String(idx + 1),
      code,
      description,
      item.supplierSku || "-",
      String(item.qty),
      fmtCurrency(item.unitPriceSen),
      fmtCurrency(item.lineTotalSen),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 16 },
    head: [[
      { content: "#", styles: { halign: "center" } },
      { content: "Item Code" },
      { content: "Description" },
      { content: "Supplier SKU" },
      { content: "Qty", styles: { halign: "right" } },
      { content: "Unit Price (RM)", styles: { halign: "right" } },
      { content: "Total (RM)", styles: { halign: "right" } },
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
      1: { cellWidth: 26, fontStyle: "bold" },
      2: { cellWidth: "auto" },
      3: { cellWidth: 26 },
      4: { cellWidth: 16, halign: "right" },
      5: { cellWidth: 27, halign: "right" },
      6: { cellWidth: 27, halign: "right", fontStyle: "bold" },
    },
    didDrawCell(data) {
      // Thin dashed separator under every item row (drawn once on the last
      // column) — the DO/SI per-row separator.
      if (data.section !== "body" || data.column.index !== 6) return;
      const yy = data.cell.y + data.cell.height;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.1);
      doc.setLineDashPattern([0.7, 0.7], 0);
      doc.line(margin, yy, pageW - margin, yy);
      doc.setLineDashPattern([], 0);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY;

  // --- Totals (mirrors the Sales Invoice: Subtotal → rule → GRAND TOTAL big
  //     + amount in words, right-aligned label + value pairs) ---
  y += 8;
  if (y > pageH - 70) {
    doc.addPage();
    y = 36;
  }
  const valX = pageW - margin;
  const lblX = pageW - margin - 42;
  const sumLine = (label: string, value: string, bold: boolean, big = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(big ? 11 : 8.5);
    doc.setTextColor(...(bold ? PDF.ink : PDF.muted));
    doc.text(label, lblX, y, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    doc.text(value, valX, y, { align: "right" });
    y += big ? 8 : 6;
  };
  // Derive subtotal from line totals when available; fall back to amountSen.
  const subtotalSen =
    pi.subtotalSen ??
    (pi.items && pi.items.length > 0
      ? pi.items.reduce((s, i) => s + (Number(i.lineTotalSen) || 0), 0)
      : pi.amountSen);
  sumLine("Subtotal", fmtRM(subtotalSen), false);
  // Rule clears the 11pt TOTAL cap height (matches the Sales Invoice spacing).
  y += 3;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.4);
  doc.line(lblX - 2, y - 5.5, valX, y - 5.5);
  // "TOTAL" (not "GRAND TOTAL") to match the Sales Invoice label exactly.
  sumLine("TOTAL", fmtRM(pi.amountSen), true, true);

  // Amount in words — mirrors the Sales Invoice confirmation line.
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF.muted);
  const words = doc.splitTextToSize(amountInWords(pi.amountSen), cw);
  doc.text(words, margin, y);
  y += words.length * 4 + 6;

  // --- Remarks ---
  if (pi.remarks) {
    const noteLines = doc.splitTextToSize(pi.remarks, cw);
    const blockH = 6 + noteLines.length * 3.6;
    if (y + blockH > pageH - 38) {
      doc.addPage();
      y = 36;
    }
    y = drawSectionLabel(doc, "Remarks", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.ink);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 3.6 + 6;
  }

  // --- Signature strip (mirrors Sales Invoice: Prepared By / Approved By) ---
  if (y + 26 > pageH - 18) {
    doc.addPage();
    y = 36;
  }
  const halfW = (pageW - margin * 2 - 14) / 2;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  doc.line(margin, y + 14, margin + halfW, y + 14);
  doc.line(pageW - margin - halfW, y + 14, pageW - margin, y + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...PDF.ink);
  doc.text("Prepared By", margin, y + 19);
  doc.text("Approved By", pageW - margin - halfW, y + 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...PDF.faint);
  doc.text(co.name, margin, y + 23.5);
  doc.text("Name / Date / Stamp", pageW - margin - halfW, y + 23.5);

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
        `${co.name} · Accounts Payable record — computer-generated document.`,
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
  doc.save(`${pi.piNo}.pdf`);
}

// Merge several purchase invoices into ONE downloadable PDF (PI list → bulk
// "Download PDF"). Same pattern as generateCombinedPurchaseOrderPdf.
export async function generateCombinedPurchaseInvoicePdf(
  items: { pi: PurchaseInvoicePdfData; letterhead?: LetterheadInfo }[],
  filename = "PurchaseInvoices.pdf",
): Promise<void> {
  if (items.length === 0) return;
  const docs = items
    .map(({ pi, letterhead }) => generatePurchaseInvoicePdf(pi, letterhead, { returnDoc: true }))
    .filter((d): d is jsPDF => !!d);
  const { downloadMergedPdf } = await import("./merge-pdf");
  await downloadMergedPdf(docs, filename);
}
