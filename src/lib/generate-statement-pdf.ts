import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { addHookkaLetterhead } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtCurrencyPlain(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Company constants
// ---------------------------------------------------------------------------

const COMPANY_NAME = "HOOKKA INDUSTRIES SDN BHD";
const COMPANY_REG = "202201012345 (1234567-X)";
const COMPANY_ADDRESS = "Lot 1234, Jalan Perindustrian 5, Kawasan Perindustrian Bukit Minyak, 14000 Bukit Mertajam, Pulau Pinang";
const COMPANY_TEL = "04-508 1234";
const COMPANY_FAX = "04-508 1235";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateStatementPdf(data: any) {
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
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("STATEMENT OF ACCOUNT", pageW - margin, margin + 2, { align: "right" });

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
    ["Account No", data.accountNo ?? "-"],
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

  // Statement details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("STATEMENT DETAILS", colRight, y);

  let yR = y + 5;
  doc.setFontSize(8);
  const stmtFields: [string, string][] = [
    ["Statement Date", fmtDate(data.statementDate)],
    ["Period", data.period ?? "-"],
    ["Currency", "MYR (RM)"],
  ];
  for (const [label, value] of stmtFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, colRight, yR);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + labelWRight, yR);
    yR += 5;
  }

  y = Math.max(yL, yR) + 4;

  // --- Account Summary Box ---
  doc.setFillColor(245, 245, 245);
  doc.rect(margin, y, pageW - margin * 2, 14, "F");
  doc.setDrawColor(200, 200, 200);
  doc.rect(margin, y, pageW - margin * 2, 14, "S");

  const summaryItems: [string, number][] = [
    ["Opening Balance", data.openingBalanceSen ?? 0],
    ["Total Debit", data.totalDebitSen ?? 0],
    ["Total Credit", data.totalCreditSen ?? 0],
    ["Closing Balance", data.closingBalanceSen ?? 0],
  ];

  const summaryColW = (pageW - margin * 2) / summaryItems.length;
  for (let i = 0; i < summaryItems.length; i++) {
    const [label, value] = summaryItems[i];
    const cx = margin + summaryColW * i + summaryColW / 2;

    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, cx, y + 5, { align: "center" });

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(fmtCurrency(value), cx, y + 11, { align: "center" });
  }

  y += 20;

  // --- Transaction Table ---
  type StatementTxn = {
    date: string;
    documentNo?: string;
    description?: string;
    debitSen?: number;
    creditSen?: number;
  };
  const transactions: StatementTxn[] = data.transactions ?? [];

  // Build table body with opening balance row
  const tableBody: string[][] = [];

  // Opening balance row
  tableBody.push([
    "",
    "",
    "Opening Balance",
    "",
    "",
    fmtCurrencyPlain(data.openingBalanceSen ?? 0),
  ]);

  let runningBalance = data.openingBalanceSen ?? 0;
  for (const txn of transactions) {
    const debit = txn.debitSen ?? 0;
    const credit = txn.creditSen ?? 0;
    runningBalance = runningBalance + debit - credit;
    tableBody.push([
      fmtDate(txn.date),
      txn.documentNo ?? "",
      txn.description ?? "",
      debit ? fmtCurrencyPlain(debit) : "",
      credit ? fmtCurrencyPlain(credit) : "",
      fmtCurrencyPlain(runningBalance),
    ]);
  }

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["Date", "Document No", "Description", "Debit (RM)", "Credit (RM)", "Balance (RM)"]],
    body: tableBody,
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [200, 200, 200],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [245, 245, 245],
      textColor: [31, 29, 27],
      fontSize: 8,
      fontStyle: "bold",
    },
    alternateRowStyles: {
      fillColor: [255, 255, 255],
    },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 28 },
      2: { cellWidth: 52 },
      3: { cellWidth: 25, halign: "right" },
      4: { cellWidth: 25, halign: "right" },
      5: { cellWidth: 25, halign: "right", fontStyle: "bold" },
    },
    // Page break handling
    didDrawPage: (hookData: { pageNumber: number }) => {
      // Repeat footer on every page
      const footerY = pageH - 10;
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(156, 163, 175);
      doc.text(`${COMPANY_NAME}  |  This is a computer-generated document.`, margin, footerY);
      doc.text(
        `Page ${doc.getNumberOfPages() > 1 ? hookData.pageNumber : 1}  |  Generated: ${fmtDate(new Date().toISOString())}`,
        pageW - margin,
        footerY,
        { align: "right" },
      );
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Closing Balance ---
  const totalsX = pageW - margin - 75;
  doc.setDrawColor(180, 180, 180);
  doc.line(totalsX, y - 1, pageW - margin, y - 1);
  y += 3;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("CLOSING BALANCE:", totalsX, y);
  doc.text(fmtCurrency(data.closingBalanceSen ?? 0), pageW - margin, y, { align: "right" });
  y += 10;

  // --- Aging Summary ---
  if (y > pageH - 50) { doc.addPage(); y = margin; }

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("AGING SUMMARY", margin, y);
  y += 3;

  const aging = data.aging ?? {};
  const agingData = [
    ["Current", aging.currentSen ?? 0],
    ["1-30 Days", aging.days30Sen ?? 0],
    ["31-60 Days", aging.days60Sen ?? 0],
    ["61-90 Days", aging.days90Sen ?? 0],
    ["Over 120 Days", aging.days120PlusSen ?? 0],
    ["Total", aging.totalSen ?? data.closingBalanceSen ?? 0],
  ];

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [agingData.map(([label]) => label as string)],
    body: [agingData.map(([, value]) => fmtCurrency(value as number))],
    styles: {
      fontSize: 8,
      cellPadding: 3,
      textColor: [31, 29, 27],
      lineColor: [200, 200, 200],
      lineWidth: 0.3,
      halign: "center",
    },
    headStyles: {
      fillColor: [245, 245, 245],
      textColor: [31, 29, 27],
      fontSize: 8,
      fontStyle: "bold",
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // --- Payment notice ---
  if (y > pageH - 30) { doc.addPage(); y = margin; }

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(
    "Please review this statement and settle any outstanding amounts promptly. If you have already made payment, please disregard this notice.",
    margin,
    y,
    { maxWidth: pageW - margin * 2 },
  );
  y += 10;

  doc.setFont("helvetica", "italic");
  doc.setTextColor(100, 100, 100);
  doc.text(
    "If there are any discrepancies, please contact our Finance Department within 7 days of receiving this statement.",
    margin,
    y,
    { maxWidth: pageW - margin * 2 },
  );

  // --- Footer (last page, if not already drawn by autoTable) ---
  const footerY = pageH - 10;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${COMPANY_NAME}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${data.customerName ? "Statement-" + data.customerName.replace(/\s+/g, "-") : "Statement"}.pdf`);
}
