import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { COMPANY } from "@/lib/constants";
import { fmtDate } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Delivery Order PDF
// ---------------------------------------------------------------------------

export function generateDOPdf(order: DeliveryOrder) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 15;
  let y = margin;

  const co = COMPANY.HOOKKA;

  // --- Header ---
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text(co.name, margin, 14);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Manufacturer of Premium Upholstered Furniture", margin, 20);
  doc.text(`Tel: ${co.phone}  |  Email: ${co.email}`, margin, 25);

  // DO Number on right
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("DELIVERY ORDER", pageW - margin, 14, { align: "right" });
  doc.setFontSize(11);
  doc.text(order.doNo, pageW - margin, 22, { align: "right" });

  // Status as plain text
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(80, 80, 80);
  const statusText = order.status.replace(/_/g, " ");
  doc.text(`Status: ${statusText}`, pageW - margin, 28, { align: "right" });

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  y = 38;
  doc.setTextColor(31, 29, 27);

  // --- Customer & Delivery Info (two columns) ---
  const colLeft = margin;
  const colRight = pageW / 2 + 5;

  // Left column - Customer
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("CUSTOMER DETAILS", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + pageW / 2 - 10, y + 7);
  y += 10;

  const customerFields = [
    ["Customer", order.customerName],
    ["State", order.customerState],
    ["Contact", order.contactPerson || "-"],
    ["Phone", order.contactPhone || "-"],
    ["Address", order.deliveryAddress || "-"],
  ];

  doc.setFontSize(8);
  for (const [label, value] of customerFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colLeft + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    // Wrap address text if needed
    if (label === "Address") {
      const lines = doc.splitTextToSize(String(value), pageW / 2 - 50);
      doc.text(lines, colLeft + 35, y);
      y += (lines.length - 1) * 4;
    } else {
      doc.text(String(value), colLeft + 35, y);
    }
    y += 5;
  }

  // Right column - Delivery Info
  let yRight = 38;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("DELIVERY DETAILS", colRight + 3, yRight + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colRight, yRight + 7, colRight + pageW / 2 - 10, yRight + 7);
  yRight += 10;

  const deliveryFields = [
    ["SO No.", order.companySOId || "-"],
    ["DO Date", fmtDate(order.deliveryDate)],
    ["Expected DD", order.hookkaExpectedDD ? fmtDate(order.hookkaExpectedDD) : "-"],
    ["Driver", order.driverName || "-"],
    ["Vehicle No.", order.vehicleNo || "-"],
    ["Total M\u00B3", order.totalM3.toFixed(2)],
  ];

  doc.setFontSize(8);
  for (const [label, value] of deliveryFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colRight + 3, yRight);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + 35, yRight);
    yRight += 5;
  }

  y = Math.max(y, yRight) + 8;

  // --- Line Items Table ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  doc.text(`ITEMS (${order.items.length} lines, ${totalQty} qty)`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const tableBody = order.items.map((item, idx) => [
    String(idx + 1),
    item.productCode,
    item.productName,
    item.sizeLabel,
    item.fabricCode,
    String(item.quantity),
    item.rackingNumber || "-",
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Product Code", "Product Name", "Size", "Fabric", "Qty", "Rack Location"]],
    body: tableBody,
    styles: {
      fontSize: 7.5,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 7.5,
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
      2: { cellWidth: 40 },
      3: { cellWidth: 22 },
      4: { cellWidth: 22 },
      5: { cellWidth: 14, halign: "right" },
      6: { cellWidth: 28, fontStyle: "bold" },
    },
    foot: [["", "", "", "", "Total", String(totalQty), ""]],
    footStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontStyle: "bold",
      fontSize: 8,
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // --- Remarks ---
  if (order.remarks) {
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, pageW - margin * 2, 15, "S");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("REMARKS", margin + 3, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(order.remarks, margin + 3, y + 9, { maxWidth: pageW - margin * 2 - 6 });
    y += 18;
  }

  // --- Signature Lines ---
  y += 5;
  const sigWidth = (pageW - margin * 2 - 20) / 3;

  const signatures = ["Prepared By", "Received By", "Date"];
  signatures.forEach((label, idx) => {
    const x = margin + idx * (sigWidth + 10);
    doc.setDrawColor(31, 29, 27);
    doc.line(x, y + 15, x + sigWidth, y + 15);
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label + ": ___", x, y + 20);
  });

  // --- Footer ---
  const footerY = doc.internal.pageSize.getHeight() - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${co.name}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(
    `Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
    pageW - margin,
    footerY,
    { align: "right" }
  );

  // Save
  doc.save(`DO-${order.doNo}.pdf`);
}
