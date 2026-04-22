import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PurchaseOrder } from "@/lib/mock-data";

function fmtCurrency(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

export function generatePurchaseOrderPdf(po: PurchaseOrder) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  // --- Header ---
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("HOOKKA INDUSTRIES SDN BHD", margin, 14);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Manufacturer of Premium Upholstered Furniture", margin, 20);
  doc.text("Tel: +60X-XXXXXXX  |  Email: procurement@hookka.com.my", margin, 25);

  // PO Title on right
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("PURCHASE ORDER", pageW - margin, 14, { align: "right" });
  doc.setFontSize(11);
  doc.text(po.poNo, pageW - margin, 22, { align: "right" });

  // Status as plain text
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(80, 80, 80);
  const statusText = po.status.replace(/_/g, " ");
  doc.text(`Status: ${statusText}`, pageW - margin, 28, { align: "right" });

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  y = 38;
  doc.setTextColor(31, 29, 27);

  // --- Two-column: Supplier (left) + PO Details (right) ---
  const colLeft = margin;
  const colRight = pageW / 2 + 5;

  // Left column - Supplier Details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPLIER DETAILS", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + pageW / 2 - 10, y + 7);
  y += 10;

  const supplierFields = [
    ["Supplier", po.supplierName],
    ["Supplier ID", po.supplierId],
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

  // Right column - PO Info
  let yRight = 38;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("ORDER DETAILS", colRight + 3, yRight + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colRight, yRight + 7, colRight + pageW / 2 - 10, yRight + 7);
  yRight += 10;

  const orderFields = [
    ["Order Date", fmtDate(po.orderDate)],
    ["Delivery Date", po.expectedDate ? fmtDate(po.expectedDate) : "-"],
    ["Payment Terms", "NET 30"],
    ["Status", po.status.replace(/_/g, " ")],
  ];

  doc.setFontSize(8);
  for (const [label, value] of orderFields) {
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
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  const totalQty = po.items.reduce((s, i) => s + i.quantity, 0);
  doc.text(`ORDER ITEMS (${po.items.length} lines, ${totalQty} qty)`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const tableBody = po.items.map((item, idx) => [
    String(idx + 1),
    item.supplierSKU,
    item.materialName,
    item.unit,
    String(item.quantity),
    fmtCurrency(item.unitPriceSen),
    fmtCurrency(item.totalSen),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Item Code", "Description", "Unit", "Qty", "Unit Price", "Total"]],
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
    alternateRowStyles: {
      fillColor: [255, 255, 255],
    },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 28, font: "helvetica", fontStyle: "bold" },
      2: { cellWidth: 50 },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 18, halign: "right" },
      5: { cellWidth: 28, halign: "right" },
      6: { cellWidth: 28, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Totals ---
  const totalsX = pageW - margin - 70;
  doc.setFontSize(8);

  // Subtotal
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Subtotal:", totalsX, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(fmtCurrency(po.subtotalSen), pageW - margin, y, { align: "right" });
  y += 5;

  // Divider
  doc.setDrawColor(226, 221, 216);
  doc.line(totalsX, y - 2, pageW - margin, y - 2);

  // Grand Total
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("GRAND TOTAL:", totalsX, y + 2);
  doc.text(fmtCurrency(po.totalSen), pageW - margin, y + 2, { align: "right" });
  y += 12;

  // --- Notes ---
  if (po.notes) {
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, pageW - margin * 2, 15, "S");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("NOTES", margin + 3, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(po.notes, margin + 3, y + 9, { maxWidth: pageW - margin * 2 - 6 });
    y += 18;
  }

  // --- Terms & Conditions ---
  y += 3;
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(55, 65, 81);
  doc.text("TERMS & CONDITIONS", margin, y);
  y += 5;

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  const terms = [
    "1. Goods must be delivered to Hookka Industries premises unless otherwise stated.",
    "2. All goods must comply with specified quality standards and specifications.",
    "3. Supplier must notify Hookka Industries of any delivery delays at least 48 hours in advance.",
    "4. Payment will be processed upon receipt and acceptance of goods as per agreed payment terms.",
    "5. Hookka Industries reserves the right to reject goods that do not meet quality requirements.",
    "6. This Purchase Order is subject to the standard terms of Hookka Industries Sdn Bhd.",
  ];

  for (const term of terms) {
    if (y > pageH - 40) {
      doc.addPage();
      y = margin;
    }
    doc.text(term, margin, y, { maxWidth: pageW - margin * 2 });
    y += 4;
  }

  // --- Authorized Signature ---
  y += 10;
  if (y > pageH - 35) {
    doc.addPage();
    y = margin + 10;
  }

  doc.setDrawColor(31, 29, 27);
  doc.line(margin, y + 12, margin + 60, y + 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(55, 65, 81);
  doc.text("Authorized Signature", margin, y + 17);
  doc.setFontSize(7);
  doc.setTextColor(107, 114, 128);
  doc.text("HOOKKA INDUSTRIES SDN BHD", margin, y + 21);

  // Date on right
  doc.line(pageW - margin - 60, y + 12, pageW - margin, y + 12);
  doc.setFontSize(8);
  doc.setTextColor(55, 65, 81);
  doc.text("Date", pageW - margin - 60, y + 17);

  // --- Footer ---
  const footerY = pageH - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text("HOOKKA INDUSTRIES SDN BHD  |  This is a computer-generated document.", margin, footerY);
  doc.text(`Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`, pageW - margin, footerY, { align: "right" });

  // Save
  doc.save(`${po.poNo}.pdf`);
}
