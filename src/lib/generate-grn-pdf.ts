import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtDate } from "@/lib/pdf-utils";

const COMPANY_NAME = COMPANY.HOOKKA.name;
const COMPANY_REG = COMPANY.HOOKKA.regNo;
const COMPANY_ADDRESS = COMPANY.HOOKKA.address;
const COMPANY_TEL = COMPANY.HOOKKA.phone;
const COMPANY_FAX = "";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateGRNPdf(data: any) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  // --- Company Header ---
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(COMPANY_NAME, margin, y);
  y += 5;

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Reg No: ${COMPANY_REG}`, margin, y);
  y += 4;
  doc.text(COMPANY_ADDRESS, margin, y, { maxWidth: pageW / 2 - 10 });
  y += 8;
  doc.text(`Tel: ${COMPANY_TEL}  |  Fax: ${COMPANY_FAX}`, margin, y);
  y += 2;

  // Title
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("GOODS RECEIVED NOTE", pageW - margin, margin + 2, { align: "right" });

  // Divider
  y += 3;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // --- Two columns ---
  const colLeft = margin;
  const colRight = pageW / 2 + 10;
  const labelW = 35;
  const labelWRight = 28;

  // Supplier details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("SUPPLIER", colLeft, y);

  let yL = y + 5;
  doc.setFontSize(8);
  const supplierFields: [string, string][] = [
    ["Name", data.supplierName ?? "-"],
    ["Address", data.supplierAddress ?? "-"],
    ["Contact", data.supplierContact ?? "-"],
  ];
  for (const [label, value] of supplierFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, colLeft, yL);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    const lines = doc.splitTextToSize(String(value), pageW / 2 - labelW - 15);
    doc.text(lines, colLeft + labelW, yL);
    yL += lines.length * 4 + 1;
  }

  // GRN details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("GRN DETAILS", colRight, y);

  let yR = y + 5;
  doc.setFontSize(8);
  const grnFields: [string, string][] = [
    ["GRN No", data.grnNo ?? "-"],
    ["Date", fmtDate(data.date)],
    ["PO Ref", data.poRef ?? "-"],
    ["DO Ref", data.doRef ?? "-"],
    ["Warehouse", data.warehouse ?? "-"],
  ];
  for (const [label, value] of grnFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, colRight, yR);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + labelWRight, yR);
    yR += 5;
  }

  y = Math.max(yL, yR) + 6;

  // --- Items Table ---
  type GRNItem = {
    itemCode?: string;
    description?: string;
    poQty?: number;
    receivedQty?: number;
    rejectedQty?: number;
    acceptedQty?: number;
  };
  const items: GRNItem[] = data.items ?? [];
  const tableBody = items.map((item, idx) => [
    String(idx + 1),
    item.itemCode ?? "",
    item.description ?? "",
    String(item.poQty ?? 0),
    String(item.receivedQty ?? 0),
    String(item.rejectedQty ?? 0),
    String(item.acceptedQty ?? 0),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["No", "Item Code", "Description", "PO Qty", "Received Qty", "Rejected Qty", "Accepted Qty"]],
    body: tableBody,
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [200, 200, 200],
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
      1: { cellWidth: 25 },
      2: { cellWidth: 55 },
      3: { cellWidth: 22, halign: "right" },
      4: { cellWidth: 22, halign: "right" },
      5: { cellWidth: 22, halign: "right" },
      6: { cellWidth: 22, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Remarks ---
  if (data.remarks) {
    if (y > pageH - 60) { doc.addPage(); y = margin; }
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text("Remarks:", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const remarkLines = doc.splitTextToSize(data.remarks, pageW - margin * 2);
    doc.text(remarkLines, margin, y);
    y += remarkLines.length * 4 + 4;
  }

  // --- Three Signature Lines ---
  y += 8;
  if (y > pageH - 45) { doc.addPage(); y = margin + 10; }

  const sigWidth = 50;
  const sigGap = (pageW - margin * 2 - sigWidth * 3) / 2;
  const sigPositions = [
    margin,
    margin + sigWidth + sigGap,
    margin + (sigWidth + sigGap) * 2,
  ];
  const sigLabels = ["Received By", "Checked By", "Approved By"];

  doc.setDrawColor(31, 29, 27);
  for (let i = 0; i < 3; i++) {
    doc.line(sigPositions[i], y + 15, sigPositions[i] + sigWidth, y + 15);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(sigLabels[i], sigPositions[i], y + 20);

    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text("Name:", sigPositions[i], y + 25);
    doc.text("Date:", sigPositions[i], y + 29);
  }

  // --- Footer ---
  const footerY = pageH - 10;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${COMPANY_NAME}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${data.grnNo ?? "GRN"}.pdf`);
}
