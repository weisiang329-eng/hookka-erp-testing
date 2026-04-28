import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM as fmtCurrency, fmtDate, amountInWords, addHookkaLetterhead } from "@/lib/pdf-utils";

const COMPANY_NAME = COMPANY.HOOKKA.name;
const COMPANY_REG = COMPANY.HOOKKA.regNo;
const COMPANY_ADDRESS = COMPANY.HOOKKA.address;
const COMPANY_TEL = COMPANY.HOOKKA.phone;
const COMPANY_FAX = "";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateCreditNotePdf(data: any) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  // --- Company Header (logo + legal text) ---
  addHookkaLetterhead(doc, margin, y - 10, 10);
  const textX = margin + 26;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(COMPANY_NAME, textX, y);
  y += 5;

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Reg No: ${COMPANY_REG}`, textX, y);
  y += 4;
  doc.text(COMPANY_ADDRESS, textX, y, { maxWidth: pageW / 2 - 10 });
  y += 8;
  doc.text(`Tel: ${COMPANY_TEL}  |  Fax: ${COMPANY_FAX}`, textX, y);
  y += 2;

  // Title
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("CREDIT NOTE", pageW - margin, margin + 2, { align: "right" });

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
  const labelWRight = 32;

  // Customer details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("CUSTOMER", colLeft, y);

  let yL = y + 5;
  doc.setFontSize(8);
  const customerFields: [string, string][] = [
    ["Name", data.customerName ?? "-"],
    ["Address", data.customerAddress ?? "-"],
    ["Attn", data.attention ?? "-"],
  ];
  for (const [label, value] of customerFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, colLeft, yL);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    const lines = doc.splitTextToSize(String(value), pageW / 2 - labelW - 15);
    doc.text(lines, colLeft + labelW, yL);
    yL += lines.length * 4 + 1;
  }

  // CN details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("CREDIT NOTE DETAILS", colRight, y);

  let yR = y + 5;
  doc.setFontSize(8);
  const cnFields: [string, string][] = [
    ["CN No", data.cnNo ?? "-"],
    ["Date", fmtDate(data.date)],
    ["Invoice Ref", data.invoiceRef ?? "-"],
    ["Invoice Date", data.invoiceDate ? fmtDate(data.invoiceDate) : "-"],
  ];
  for (const [label, value] of cnFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, colRight, yR);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + labelWRight, yR);
    yR += 5;
  }

  y = Math.max(yL, yR) + 6;

  // --- Reason ---
  if (data.reason) {
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text("Reason for Credit Note:", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const reasonLines = doc.splitTextToSize(data.reason, pageW - margin * 2);
    doc.text(reasonLines, margin, y);
    y += reasonLines.length * 4 + 4;
  }

  // --- Items Table ---
  type CreditNoteItem = {
    description?: string;
    qty?: number;
    unitPriceSen?: number;
    amountSen?: number;
  };
  const items: CreditNoteItem[] = data.items ?? [];
  const tableBody = items.map((item, idx) => [
    String(idx + 1),
    item.description ?? "",
    String(item.qty ?? 0),
    fmtCurrency(item.unitPriceSen ?? 0),
    fmtCurrency(item.amountSen ?? 0),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["No", "Description", "Qty", "Unit Price (RM)", "Amount (RM)"]],
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
      0: { cellWidth: 12, halign: "center" },
      1: { cellWidth: 75 },
      2: { cellWidth: 20, halign: "right" },
      3: { cellWidth: 30, halign: "right" },
      4: { cellWidth: 30, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Total ---
  const totalsX = pageW - margin - 75;

  doc.setDrawColor(180, 180, 180);
  doc.line(totalsX, y - 1, pageW - margin, y - 1);
  y += 3;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("TOTAL CREDIT:", totalsX, y);
  doc.text(fmtCurrency(data.totalSen ?? 0), pageW - margin, y, { align: "right" });
  y += 6;

  // Amount in words
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(80, 80, 80);
  doc.text(`Amount in words: ${amountInWords(data.totalSen ?? 0)}`, margin, y, { maxWidth: pageW - margin * 2 });
  y += 12;

  // --- Signature Lines ---
  if (y > pageH - 40) { doc.addPage(); y = margin + 10; }

  const sigWidth = 65;
  const sigLeftX = margin;
  const sigRightX = pageW - margin - sigWidth;

  doc.setDrawColor(31, 29, 27);
  doc.line(sigLeftX, y + 15, sigLeftX + sigWidth, y + 15);
  doc.line(sigRightX, y + 15, sigRightX + sigWidth, y + 15);

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("Prepared By", sigLeftX, y + 20);
  doc.text("Approved By", sigRightX, y + 20);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_NAME, sigLeftX, y + 24);
  doc.text(COMPANY_NAME, sigRightX, y + 24);

  // --- Footer ---
  const footerY = pageH - 10;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${COMPANY_NAME}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${data.cnNo ?? "CreditNote"}.pdf`);
}
