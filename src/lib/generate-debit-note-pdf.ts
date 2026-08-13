import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM as fmtCurrency, fmtDate, amountInWords, drawLetterhead } from "@/lib/pdf-utils";

// Company name for the signature / footer lines (header now via drawLetterhead).
const COMPANY_NAME = COMPANY.HOOKKA.name;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateDebitNotePdf(data: any) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;

  // --- Header (shared letterhead — single source of truth across all docs) ---
  let y = drawLetterhead(doc, {
    docTitle: "DEBIT NOTE",
    docNo: data.dnNo ?? data.noteNumber ?? "-",
    docDate: fmtDate(data.date),
    company: "HOOKKA",
  });

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

  // DN details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("DEBIT NOTE DETAILS", colRight, y);

  let yR = y + 5;
  doc.setFontSize(8);
  const dnFields: [string, string][] = [
    ["DN No", data.dnNo ?? data.noteNumber ?? "-"],
    ["Date", fmtDate(data.date)],
    ["Invoice Ref", data.invoiceRef ?? data.invoiceNumber ?? "-"],
    ["Invoice Date", data.invoiceDate ? fmtDate(data.invoiceDate) : "-"],
  ];
  for (const [label, value] of dnFields) {
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
    doc.text("Reason for Debit Note:", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const reasonLines = doc.splitTextToSize(data.reason, pageW - margin * 2);
    doc.text(reasonLines, margin, y);
    y += reasonLines.length * 4 + 4;
  }

  // --- Items Table ---
  // The API (routes/debit-notes.ts `parseItems`) emits
  // `quantity` / `unitPriceSen` / `totalSen`; the older wire shape this
  // generator was written against used `qty` / `amountSen`. The page hands the
  // raw API row straight in (debit-notes.tsx:239), so read both spellings —
  // before this, Qty and Amount printed 0 on every downloaded debit note.
  // (BUG-2026-08-13-034)
  type DebitNoteItem = {
    description?: string;
    qty?: number;
    quantity?: number;
    unitPriceSen?: number;
    amountSen?: number;
    totalSen?: number;
  };
  const items: DebitNoteItem[] = data.items ?? [];
  const tableBody = items.map((item, idx) => [
    String(idx + 1),
    item.description ?? "",
    String(item.qty ?? item.quantity ?? 0),
    fmtCurrency(item.unitPriceSen ?? 0),
    fmtCurrency(item.amountSen ?? item.totalSen ?? 0),
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
  doc.text("TOTAL DEBIT:", totalsX, y);
  doc.text(fmtCurrency(data.totalSen ?? data.totalAmount ?? 0), pageW - margin, y, { align: "right" });
  y += 6;

  // Amount in words
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(80, 80, 80);
  doc.text(`Amount in words: ${amountInWords(data.totalSen ?? data.totalAmount ?? 0)}`, margin, y, { maxWidth: pageW - margin * 2 });
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

  doc.save(`${data.dnNo ?? data.noteNumber ?? "DebitNote"}.pdf`);
}
