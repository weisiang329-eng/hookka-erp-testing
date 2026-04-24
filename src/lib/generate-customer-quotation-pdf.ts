import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM, fmtDate } from "@/lib/pdf-utils";

// Fixed seat-height set the sales team quotes against. Keep ordered
// so columns line up the same way across every quotation.
const SEAT_HEIGHTS = ["24", "28", "30", "32", "35"] as const;

export type QuotationCustomer = {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
};

export type QuotationProduct = {
  code: string;
  name: string;
  category: string;
  basePriceSen: number;
  price1Sen: number | null;
  seatHeightPrices: Array<{ height: string; priceSen: number }> | null;
};

export type QuotationArgs = {
  customer: QuotationCustomer;
  products: QuotationProduct[];
};

function formatSeatHeightsCell(
  category: string,
  sh: Array<{ height: string; priceSen: number }> | null,
): string {
  if (category !== "SOFA") return "—";
  const map = new Map<string, number>();
  if (sh) for (const t of sh) map.set(String(t.height), t.priceSen);
  return SEAT_HEIGHTS.map((h) => {
    const v = map.get(h);
    const cell = v != null ? (v / 100).toFixed(2) : "—";
    return `${h}":${cell}`;
  }).join(" ");
}

export default function generateCustomerQuotationPdf(args: QuotationArgs): jsPDF {
  const { customer, products } = args;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const co = COMPANY.HOOKKA;
  const today = new Date().toISOString();

  // =========================================================================
  // 1. COMPANY HEADER — mirrors generate-invoice-pdf.ts verbatim
  // =========================================================================
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(co.name, margin, 12);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Reg No: ${co.regNo}`, margin, 17);
  doc.text(co.address, margin, 22);
  doc.text(`Tel: ${co.phone}`, margin, 27);

  // =========================================================================
  // 2. QUOTATION TITLE (right side)
  // =========================================================================
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("QUOTATION", pageW - margin, 14, { align: "right" });

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(customer.name, pageW - margin, 22, { align: "right" });

  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  doc.text(fmtDate(today), pageW - margin, 28, { align: "right" });

  // Divider
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  let y = 40;
  doc.setTextColor(31, 29, 27);

  // =========================================================================
  // 3. BILL TO
  // =========================================================================
  const colLeft = margin;
  const boxW = pageW / 2 - 10;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BILL TO", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + boxW, y + 7);

  let yLeft = y + 10;
  const billToFields: [string, string][] = [
    ["Customer", customer.name || "-"],
    ["Address", customer.address || "-"],
    ["Phone", customer.phone || "-"],
    ["Email", customer.email || "-"],
  ];

  doc.setFontSize(8);
  for (const [label, value] of billToFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colLeft + 3, yLeft);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    const lines = doc.splitTextToSize(String(value), boxW - 40);
    doc.text(lines, colLeft + 30, yLeft);
    yLeft += lines.length * 4 + 1;
  }

  y = yLeft + 8;

  // =========================================================================
  // 4. SKU TABLE
  // =========================================================================
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`ASSIGNED SKUS (${products.length})`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const body = products.map((p, idx) => [
    String(idx + 1),
    p.code,
    p.name,
    p.category,
    fmtRM(p.basePriceSen),
    p.price1Sen != null ? fmtRM(p.price1Sen) : "—",
    formatSeatHeightsCell(p.category, p.seatHeightPrices),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Code", "Name", "Category", "Base Price (RM)", "Price 1 (RM)", "Seat Heights"]],
    body,
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
      overflow: "linebreak",
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
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: 22 },
      2: { cellWidth: 52 },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 22, halign: "right" },
      5: { cellWidth: 20, halign: "right" },
      6: { cellWidth: "auto", fontSize: 6.5 },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 6;

  // =========================================================================
  // 5. FOOTER NOTE
  // =========================================================================
  if (y > pageH - 20) {
    doc.addPage();
    y = margin;
  }
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Prices exported ${fmtDate(today)}. Subject to change on the next revision.`,
    margin,
    y,
  );

  // --- Page footers (all pages) ---
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const footerY = pageH - 10;
    doc.setDrawColor(226, 221, 216);
    doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${co.name}  |  This is a computer-generated document. No signature is required.`,
      margin,
      footerY,
    );
    doc.text(
      `Page ${p} of ${totalPages}  |  Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
      pageW - margin,
      footerY,
      { align: "right" },
    );
  }

  return doc;
}
