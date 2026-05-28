import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { addHookkaLetterhead } from "@/lib/pdf-utils";

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Packing List PDF - Compact warehouse picking document
// ---------------------------------------------------------------------------

export function generatePackingListPdf(order: DeliveryOrder) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 15;
  let y = margin;

  // --- Header (compact) ---
  addHookkaLetterhead(doc, margin, 6, 8);
  const textX = margin + 21;

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("PACKING LIST", textX, 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("HOOKKA INDUSTRIES SDN BHD", textX, 17);

  // DO reference on right
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(order.doNo, pageW - margin, 12, { align: "right" });
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`SO: ${order.companySOId || "-"}`, pageW - margin, 18, { align: "right" });

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 22, pageW - margin, 22);

  y = 28;
  doc.setTextColor(31, 29, 27);

  // --- Quick Info Row ---
  doc.setDrawColor(200, 200, 200);
  doc.rect(margin, y, pageW - margin * 2, 14, "S");

  doc.setFontSize(8);
  const infoY = y + 5;
  const col1 = margin + 3;
  const col2 = margin + 65;
  const col3 = margin + 125;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Customer:", col1, infoY);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(order.customerName, col1 + 22, infoY);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Delivery Date:", col2, infoY);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(fmtDate(order.deliveryDate), col2 + 28, infoY);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Total Items:", col3, infoY);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(String(order.totalItems), col3 + 24, infoY);

  // Second row of info
  const infoY2 = y + 10;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Driver:", col1, infoY2);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(order.driverName || "-", col1 + 22, infoY2);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Vehicle:", col2, infoY2);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(order.vehicleNo || "-", col2 + 28, infoY2);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Total M\u00B3:", col3, infoY2);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(order.totalM3.toFixed(2), col3 + 24, infoY2);

  y += 20;

  // --- Items Table with Picked checkbox column ---
  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);

  const tableBody = order.items.map((item, idx) => [
    String(idx + 1),
    item.productCode,
    item.productName,
    item.sizeLabel,
    item.fabricCode,
    String(item.quantity),
    item.rackingNumber || "-",
    "\u2610", // ☐ checkbox character
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Product Code", "Product Name", "Size", "Fabric", "Qty", "RACK LOCATION", "Picked"]],
    body: tableBody,
    styles: {
      fontSize: 8,
      cellPadding: 3,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [245, 245, 245],
      textColor: [0, 0, 0],
      fontSize: 8,
      fontStyle: "bold",
    },
    alternateRowStyles: {
      fillColor: [255, 255, 255],
    },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 24, fontStyle: "bold" },
      2: { cellWidth: 36 },
      3: { cellWidth: 20 },
      4: { cellWidth: 20 },
      5: { cellWidth: 12, halign: "right" },
      6: { cellWidth: 30, fontStyle: "bold" }, // rack column
      7: { cellWidth: 16, halign: "center", fontSize: 12 },
    },
    foot: [["", "", "", "", "Total", String(totalQty), "", ""]],
    footStyles: {
      fillColor: [245, 245, 245],
      textColor: [0, 0, 0],
      fontStyle: "bold",
      fontSize: 8,
    },
    // Highlight rack location body cells with bold text (no fill)
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 6) {
        data.cell.styles.fontStyle = "bold";
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 10;

  // --- Picker signature ---
  const sigWidth = (pageW - margin * 2 - 10) / 2;
  doc.setDrawColor(31, 29, 27);
  doc.line(margin, y + 12, margin + sigWidth, y + 12);
  doc.line(margin + sigWidth + 10, y + 12, pageW - margin, y + 12);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Picked By:", margin, y + 17);
  doc.text("Checked By:", margin + sigWidth + 10, y + 17);

  // --- Footer ---
  const footerY = doc.internal.pageSize.getHeight() - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text("HOOKKA INDUSTRIES SDN BHD  |  Warehouse Packing List", margin, footerY);
  doc.text(
    `Printed: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
    pageW - margin,
    footerY,
    { align: "right" }
  );

  // Save
  doc.save(`PackingList-${order.doNo}.pdf`);
}
