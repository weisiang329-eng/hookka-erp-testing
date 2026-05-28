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

// ---------------------------------------------------------------------------
// Consolidated Packing List PDF — one truck / one delivery run, many hubs.
//
// A delivery order is now restricted to a single hub, so a truck that drops
// at 5 hubs is 5 separate DOs. This document merges the operator-selected
// DOs into ONE loading sheet: a run summary at the top, then one section per
// stop (hub) with its own items table + ☐ load checkboxes, so the warehouse
// loads the whole truck from a single page while each hub keeps its own DO.
// ---------------------------------------------------------------------------

interface PackingListItem {
  productCode?: string;
  productName?: string;
  sizeLabel?: string;
  fabricCode?: string;
  quantity?: number;
  itemM3?: number;
  rackingNumber?: string;
}

interface PackingListStop {
  doNo: string;
  customerName?: string;
  hubName?: string;
  hubState?: string;
  deliveryAddress?: string;
  contactPerson?: string;
  contactPhone?: string;
  deliveryDate?: string;
  driverName?: string;
  vehicleNo?: string;
  totalM3?: number;
  items: PackingListItem[];
}

function uniqueNonEmpty(values: (string | undefined | null)[]): string[] {
  return Array.from(
    new Set(values.map((v) => (v || "").trim()).filter(Boolean)),
  );
}

function summarise(values: (string | undefined | null)[]): string {
  const u = uniqueNonEmpty(values);
  if (u.length === 0) return "-";
  if (u.length === 1) return u[0];
  return "Multiple";
}

export function generateConsolidatedPackingListPdf(stops: PackingListStop[]) {
  if (!stops || stops.length === 0) return;

  // Sort stops so same-region hubs sit together (helps loading order).
  const ordered = [...stops].sort((a, b) => {
    const s = (a.hubState || "").localeCompare(b.hubState || "");
    if (s !== 0) return s;
    const h = (a.hubName || a.customerName || "").localeCompare(
      b.hubName || b.customerName || "",
    );
    if (h !== 0) return h;
    return (a.doNo || "").localeCompare(b.doNo || "");
  });

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;

  // --- Run totals ---
  const totalDOs = ordered.length;
  const totalItems = ordered.reduce((s, st) => s + st.items.length, 0);
  const totalUnits = ordered.reduce(
    (s, st) => s + st.items.reduce((q, i) => q + (i.quantity || 0), 0),
    0,
  );
  const totalM3 = ordered.reduce((s, st) => s + (st.totalM3 || 0), 0);
  const distinctHubs = uniqueNonEmpty(
    ordered.map((st) => st.hubName || st.deliveryAddress || st.customerName),
  ).length;
  const runDate = summarise(ordered.map((st) => st.deliveryDate));
  const runVehicle = summarise(ordered.map((st) => st.vehicleNo));
  const runDriver = summarise(ordered.map((st) => st.driverName));

  // --- Header ---
  addHookkaLetterhead(doc, margin, 6, 8);
  const textX = margin + 21;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("PACKING LIST", textX, 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("HOOKKA INDUSTRIES SDN BHD  -  Consolidated Delivery Run", textX, 17);

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`${totalDOs} DO  /  ${distinctHubs} Stops`, pageW - margin, 12, {
    align: "right",
  });
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Date: ${fmtDate(runDate === "Multiple" ? "" : runDate)}`, pageW - margin, 18, {
    align: "right",
  });

  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 22, pageW - margin, 22);

  // --- Run summary box ---
  let y = 27;
  doc.setDrawColor(200, 200, 200);
  doc.rect(margin, y, pageW - margin * 2, 14, "S");
  const col1 = margin + 3;
  const col2 = margin + 70;
  const col3 = margin + 130;
  const infoY = y + 5;
  const infoY2 = y + 10;
  const kv = (label: string, value: string, x: number, yy: number, labelW: number) => {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, x, yy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(value, x + labelW, yy);
  };
  doc.setFontSize(8);
  kv("Vehicle:", runVehicle, col1, infoY, 22);
  kv("Driver:", runDriver, col2, infoY, 22);
  kv("Total Units:", String(totalUnits), col3, infoY, 24);
  kv("Stops:", String(distinctHubs), col1, infoY2, 22);
  kv("Line Items:", String(totalItems), col2, infoY2, 22);
  kv("Total M³:", totalM3.toFixed(2), col3, infoY2, 24);

  y += 20;

  // --- Per-stop sections ---
  ordered.forEach((stop, stopIdx) => {
    const stopTitle = stop.hubName || stop.customerName || "Stop";
    const stopQty = stop.items.reduce((q, i) => q + (i.quantity || 0), 0);

    // Page-break guard: need room for the stop header (~16mm) + a couple rows.
    if (y > pageH - 50) {
      doc.addPage();
      y = margin;
    }

    // Stop header bar
    doc.setFillColor(245, 245, 245);
    doc.rect(margin, y, pageW - margin * 2, 8, "F");
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text(
      `STOP ${stopIdx + 1}  -  ${stopTitle}${stop.hubState ? ` (${stop.hubState})` : ""}`,
      margin + 3,
      y + 5.5,
    );
    doc.setFontSize(9);
    doc.text(stop.doNo, pageW - margin - 3, y + 5.5, { align: "right" });

    // Address / contact line
    y += 12;
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    const addr = stop.deliveryAddress?.trim() || "-";
    const contactBits = [stop.contactPerson, stop.contactPhone]
      .map((b) => (b || "").trim())
      .filter(Boolean)
      .join("  /  ");
    const addrLines = doc.splitTextToSize(
      `Deliver to: ${addr}${contactBits ? `   |   Contact: ${contactBits}` : ""}`,
      pageW - margin * 2 - 6,
    );
    doc.text(addrLines, margin + 3, y);
    y += addrLines.length * 4 + 2;

    // Items table
    const tableBody = stop.items.map((item, idx) => [
      String(idx + 1),
      item.productCode || "-",
      item.productName || "-",
      item.sizeLabel || "-",
      item.fabricCode || "-",
      String(item.quantity ?? 0),
      item.rackingNumber || "-",
      "☐",
    ]);

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["#", "Product Code", "Product Name", "Size", "Fabric", "Qty", "RACK LOCATION", "Loaded"]],
      body: tableBody,
      styles: {
        fontSize: 8,
        cellPadding: 2.5,
        textColor: [31, 29, 27],
        lineColor: [226, 221, 216],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [250, 249, 247],
        textColor: [0, 0, 0],
        fontSize: 8,
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: {
        0: { cellWidth: 10, halign: "center" },
        1: { cellWidth: 24, fontStyle: "bold" },
        2: { cellWidth: 36 },
        3: { cellWidth: 20 },
        4: { cellWidth: 20 },
        5: { cellWidth: 12, halign: "right" },
        6: { cellWidth: 30, fontStyle: "bold" },
        7: { cellWidth: 16, halign: "center", fontSize: 12 },
      },
      foot: [["", "", "", "", "Stop Total", String(stopQty), "", ""]],
      footStyles: {
        fillColor: [250, 249, 247],
        textColor: [0, 0, 0],
        fontStyle: "bold",
        fontSize: 8,
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  });

  // --- Signatures (place on the current page, push to a new one if tight) ---
  if (y > pageH - 30) {
    doc.addPage();
    y = margin;
  }
  const sigWidth = (pageW - margin * 2 - 10) / 2;
  doc.setDrawColor(31, 29, 27);
  doc.line(margin, y + 12, margin + sigWidth, y + 12);
  doc.line(margin + sigWidth + 10, y + 12, pageW - margin, y + 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Loaded By:", margin, y + 17);
  doc.text("Checked By:", margin + sigWidth + 10, y + 17);

  // --- Footer on every page ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const footerY = pageH - 12;
    doc.setDrawColor(226, 221, 216);
    doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(156, 163, 175);
    doc.text("HOOKKA INDUSTRIES SDN BHD  |  Consolidated Packing List", margin, footerY);
    doc.text(`Page ${p} / ${pageCount}`, pageW / 2, footerY, { align: "center" });
    doc.text(
      `Printed: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
      pageW - margin,
      footerY,
      { align: "right" },
    );
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  doc.save(`PackingList-Run-${stamp}-${totalDOs}DO.pdf`);
}
