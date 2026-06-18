import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { addHookkaLetterhead } from "@/lib/pdf-utils";
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
};

function fmtCurrency(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

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

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  // --- Header ---
  if (isHookkaLetterhead) {
    addHookkaLetterhead(doc, margin, 5, 10);
  }
  const textX = isHookkaLetterhead ? margin + 26 : margin;

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(co.name, textX, 14);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  if (co.tagline) {
    doc.text(co.tagline, textX, 20);
  }
  const contactLine = [
    co.phone ? `Tel: ${co.phone}` : "",
    co.email ? `Email: ${co.email}` : "",
  ]
    .filter(Boolean)
    .join("  |  ");
  if (contactLine) {
    doc.text(contactLine, textX, 25);
  }

  // Title on right
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("PURCHASE INVOICE", pageW - margin, 14, { align: "right" });
  doc.setFontSize(11);
  doc.text(pi.piNo, pageW - margin, 22, { align: "right" });

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(80, 80, 80);
  doc.text(`Status: ${pi.status.replace(/_/g, " ")}`, pageW - margin, 28, { align: "right" });

  // Divider
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  y = 38;
  doc.setTextColor(31, 29, 27);

  const colLeft = margin;
  const colRight = pageW / 2 + 5;

  // Left column - Supplier
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPLIER DETAILS", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + pageW / 2 - 10, y + 7);
  y += 10;

  const supplierFields: Array<[string, string]> = [
    ["Supplier", pi.supplierName],
    ["Supplier ID", pi.supplierId || "-"],
  ];
  doc.setFontSize(8);
  for (const [label, value] of supplierFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colLeft + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colLeft + 35, y);
    y += 5;
  }

  // Right column - Invoice info
  let yRight = 38;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("INVOICE DETAILS", colRight + 3, yRight + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colRight, yRight + 7, colRight + pageW / 2 - 10, yRight + 7);
  yRight += 10;

  const infoFields: Array<[string, string]> = [
    ["Invoice Date", fmtDate(pi.invoiceDate)],
    ["Due Date", fmtDate(pi.dueDate)],
    ["Linked PO", pi.poRef || (pi.purchaseOrderId ? pi.purchaseOrderId : "-")],
    ["Status", pi.status.replace(/_/g, " ")],
  ];
  doc.setFontSize(8);
  for (const [label, value] of infoFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colRight + 3, yRight);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + 40, yRight);
    yRight += 5;
  }

  y = Math.max(y, yRight) + 8;

  // --- Items Table ---
  const items = pi.items ?? [];
  const totalQty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`INVOICE ITEMS (${items.length} lines, ${totalQty} qty)`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  // Item Code column shows the material code for STOCKED lines, else the
  // line-type tag (FEE / TAX / REBATE / …) so non-stock charges read clearly.
  const codeFor = (l: PurchaseInvoicePdfLine): string => {
    const lt = (l.lineType || "STOCKED").toUpperCase();
    if (lt === "STOCKED") return l.materialCode || "-";
    return lt;
  };

  const tableBody = items.map((item, idx) => [
    String(idx + 1),
    codeFor(item),
    item.materialName,
    item.supplierSku || "-",
    String(item.qty),
    fmtCurrency(item.unitPriceSen),
    fmtCurrency(item.lineTotalSen),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Item Code", "Description", "Supplier SKU", "Qty", "Unit Price", "Total"]],
    body: tableBody,
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 8,
      fontStyle: "bold",
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
    alternateRowStyles: { fillColor: [255, 255, 255] },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 26, font: "helvetica", fontStyle: "bold" },
      2: { cellWidth: 48 },
      3: { cellWidth: 26 },
      4: { cellWidth: 16, halign: "right" },
      5: { cellWidth: 27, halign: "right" },
      6: { cellWidth: 27, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Totals ---
  const totalsX = pageW - margin - 70;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("GRAND TOTAL:", totalsX, y + 2);
  doc.text(fmtCurrency(pi.amountSen), pageW - margin, y + 2, { align: "right" });
  y += 12;

  // --- Remarks ---
  if (pi.remarks) {
    if (y > pageH - 40) {
      doc.addPage();
      y = margin;
    }
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, pageW - margin * 2, 15, "S");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("REMARKS", margin + 3, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(pi.remarks, margin + 3, y + 9, { maxWidth: pageW - margin * 2 - 6 });
    y += 18;
  }

  // --- Footer ---
  const footerY = pageH - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${co.name}  |  Accounts Payable record — computer-generated document.`, margin, footerY);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
    pageW - margin,
    footerY,
    { align: "right" },
  );

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
