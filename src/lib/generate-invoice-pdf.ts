import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM as fmtCurrency, fmtDate, amountInWords } from "@/lib/pdf-utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateInvoicePdf(invoice: any) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  const co = COMPANY.HOOKKA;
  const companyName = invoice.companyName || co.name;

  // =========================================================================
  // 1. COMPANY HEADER
  // =========================================================================
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(companyName, margin, 12);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Reg No: ${co.regNo}`, margin, 17);
  doc.text(co.address, margin, 22);
  doc.text(`Tel: ${co.phone}`, margin, 27);

  // =========================================================================
  // 2. INVOICE TITLE (right side of header)
  // =========================================================================
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("INVOICE", pageW - margin, 14, { align: "right" });

  doc.setFontSize(11);
  doc.text(invoice.invoiceNo || "", pageW - margin, 22, { align: "right" });

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(fmtDate(invoice.invoiceDate), pageW - margin, 28, { align: "right" });

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  y = 40;
  doc.setTextColor(31, 29, 27);

  // =========================================================================
  // 3. BILL TO (left) + 4. INVOICE DETAILS (right)
  // =========================================================================
  const colLeft = margin;
  const colRight = pageW / 2 + 5;
  const boxW = pageW / 2 - 10;

  // -- Bill To --
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BILL TO", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + boxW, y + 7);

  let yLeft = y + 10;
  const billToFields: [string, string][] = [
    ["Customer", invoice.customerName || "-"],
    ["Address", invoice.customerAddress || invoice.customerState || "-"],
    ["Attention", invoice.attention || "-"],
    ["Phone", invoice.customerPhone || "-"],
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

  // -- Invoice Details --
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("INVOICE DETAILS", colRight + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colRight, y + 7, colRight + boxW, y + 7);

  let yRight = y + 10;
  const detailFields: [string, string][] = [
    ["Invoice No", invoice.invoiceNo || "-"],
    ["Date", fmtDate(invoice.invoiceDate)],
    ["SO Ref", invoice.soRef || invoice.companySOId || "-"],
    ["DO Ref", invoice.doRef || invoice.doNo || "-"],
    ["Terms", invoice.terms || "NET 30"],
    ["Due Date", fmtDate(invoice.dueDate)],
  ];

  doc.setFontSize(8);
  for (const [label, value] of detailFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colRight + 3, yRight);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + 35, yRight);
    yRight += 5;
  }

  y = Math.max(yLeft, yRight) + 8;

  // =========================================================================
  // 5. ITEMS TABLE
  // =========================================================================
  const items = invoice.items || [];

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalQty = items.reduce((s: number, i: any) => s + (i.quantity || 0), 0);
  doc.text(`ITEMS (${items.length} lines, ${totalQty} qty)`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableBody = items.map((item: any, idx: number) => {
    const descParts = [item.productName || item.description || ""];
    if (item.sizeLabel) descParts.push(`Size: ${item.sizeLabel}`);
    if (item.fabricCode) descParts.push(`Fabric: ${item.fabricCode}`);
    if (item.productCode) descParts.push(`Code: ${item.productCode}`);
    return [
      String(idx + 1),
      descParts.join("\n"),
      String(item.quantity ?? ""),
      fmtCurrency(item.unitPriceSen || 0),
      fmtCurrency(item.totalSen || 0),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["No", "Description", "Qty", "Unit Price (RM)", "Amount (RM)"]],
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
      0: { cellWidth: 12, halign: "center" },
      1: { cellWidth: 75 },
      2: { cellWidth: 18, halign: "center" },
      3: { cellWidth: 32, halign: "right" },
      4: { cellWidth: 32, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // =========================================================================
  // 6. TOTALS
  // =========================================================================
  const totalsX = pageW - margin - 80;

  // Subtotal
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Subtotal:", totalsX, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(fmtCurrency(invoice.subtotalSen || 0), pageW - margin, y, { align: "right" });
  y += 6;

  // Divider
  doc.setDrawColor(226, 221, 216);
  doc.line(totalsX, y - 2, pageW - margin, y - 2);

  // Grand Total
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("TOTAL:", totalsX, y + 2);
  doc.text(fmtCurrency(invoice.totalSen || 0), pageW - margin, y + 2, { align: "right" });
  y += 10;

  // Amount in words
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(75, 85, 99);
  const wordsText = amountInWords(invoice.totalSen || 0);
  const wordsLines = doc.splitTextToSize(wordsText, pageW - margin * 2);
  doc.text(wordsLines, margin, y);
  y += wordsLines.length * 4 + 6;

  // =========================================================================
  // 7. BANK DETAILS
  // =========================================================================
  if (y > pageH - 70) {
    doc.addPage();
    y = margin;
  }

  doc.setDrawColor(200, 200, 200);
  doc.rect(margin, y, pageW - margin * 2, 28, "S");

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BANK DETAILS", margin + 3, y + 5);

  const bankFields: [string, string][] = [
    ["Bank", "CIMB Bank Berhad"],
    ["Account Name", co.name],
    ["Account No", "8012345678"],
  ];

  let bY = y + 10;
  doc.setFontSize(8);
  for (const [label, value] of bankFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin + 3, bY);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(value, margin + 40, bY);
    bY += 5;
  }

  doc.setFontSize(7);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(107, 114, 128);
  doc.text("Please make payment within stated terms.", margin + 3, y + 26);

  y += 34;

  // =========================================================================
  // 8. FOOTER — Signature lines
  // =========================================================================
  if (y > pageH - 50) {
    doc.addPage();
    y = margin + 10;
  }

  y += 5;

  // Prepared By (left)
  doc.setDrawColor(31, 29, 27);
  doc.line(margin, y + 12, margin + 60, y + 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(55, 65, 81);
  doc.text("Prepared By", margin, y + 17);
  doc.setFontSize(7);
  doc.setTextColor(107, 114, 128);
  doc.text(companyName, margin, y + 21);

  // Received By (right)
  doc.line(pageW - margin - 60, y + 12, pageW - margin, y + 12);
  doc.setFontSize(8);
  doc.setTextColor(55, 65, 81);
  doc.text("Received By", pageW - margin - 60, y + 17);
  doc.setFontSize(7);
  doc.setTextColor(107, 114, 128);
  doc.text("Customer Stamp & Signature", pageW - margin - 60, y + 21);

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
      `${companyName}  |  This is a computer-generated document. No signature is required.`,
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

  // Save
  doc.save(`${invoice.invoiceNo || "INVOICE"}.pdf`);
}
