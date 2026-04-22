import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

function amountInWords(sen: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function convert(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
    if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + convert(n % 100) : "");
    if (n < 1000000) return convert(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + convert(n % 1000) : "");
    return convert(Math.floor(n / 1000000)) + " Million" + (n % 1000000 ? " " + convert(n % 1000000) : "");
  }

  const ringgit = Math.floor(sen / 100);
  const remainingSen = sen % 100;
  let result = "Ringgit Malaysia " + (ringgit === 0 ? "Zero" : convert(ringgit));
  if (remainingSen > 0) {
    result += " and " + convert(remainingSen) + " Sen";
  }
  result += " Only";
  return result;
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
export function generateQuotationPdf(data: any) {
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

  // Title on top right
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("QUOTATION", pageW - margin, margin + 2, { align: "right" });

  // Divider line
  y += 3;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // --- Two columns: Customer Info (left) + Quotation Details (right) ---
  const colLeft = margin;
  const colRight = pageW / 2 + 10;
  const labelW = 35;
  const labelWRight = 30;

  // Left column - Customer Details
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
    ["Tel", data.customerTel ?? "-"],
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

  // Right column - Quotation Info
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("QUOTATION DETAILS", colRight, y);

  let yR = y + 5;
  doc.setFontSize(8);
  const quotationFields: [string, string][] = [
    ["Quotation No", data.quotationNo ?? "-"],
    ["Date", fmtDate(data.date)],
    ["Validity", data.validity ?? "Valid for 30 days"],
    ["Payment", data.paymentTerms ?? "NET 30"],
    ["Delivery", data.deliverySchedule ?? "-"],
  ];
  for (const [label, value] of quotationFields) {
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
  type QuotationItem = {
    description?: string;
    size?: string;
    fabric?: string;
    qty?: number;
    unitPriceSen?: number;
    amountSen?: number;
  };
  const items: QuotationItem[] = data.items ?? [];
  const tableBody = items.map((item, idx) => [
    String(idx + 1),
    item.description ?? "",
    item.size ?? "",
    item.fabric ?? "",
    String(item.qty ?? 0),
    fmtCurrency(item.unitPriceSen ?? 0),
    fmtCurrency(item.amountSen ?? 0),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["No", "Description", "Size", "Fabric", "Qty", "Unit Price (RM)", "Amount (RM)"]],
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
      1: { cellWidth: 45 },
      2: { cellWidth: 22, halign: "center" },
      3: { cellWidth: 25, halign: "center" },
      4: { cellWidth: 15, halign: "right" },
      5: { cellWidth: 28, halign: "right" },
      6: { cellWidth: 28, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Totals ---
  const totalsX = pageW - margin - 75;

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text("Subtotal:", totalsX, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(fmtCurrency(data.subtotalSen ?? 0), pageW - margin, y, { align: "right" });
  y += 5;

  if (data.discountSen) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text("Discount:", totalsX, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(`(${fmtCurrency(data.discountSen)})`, pageW - margin, y, { align: "right" });
    y += 5;
  }

  // Divider
  doc.setDrawColor(180, 180, 180);
  doc.line(totalsX, y - 1, pageW - margin, y - 1);
  y += 3;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("TOTAL:", totalsX, y);
  doc.text(fmtCurrency(data.totalSen ?? 0), pageW - margin, y, { align: "right" });
  y += 6;

  // Amount in words
  doc.setFontSize(8);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(80, 80, 80);
  doc.text(`Amount in words: ${amountInWords(data.totalSen ?? 0)}`, margin, y, { maxWidth: pageW - margin * 2 });
  y += 10;

  // --- Terms & Conditions ---
  if (y > pageH - 70) { doc.addPage(); y = margin; }

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text("TERMS & CONDITIONS", margin, y);
  y += 5;

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  const terms = data.terms ?? [
    `1. This quotation is valid for ${data.validity ?? "30 days"} from the date of issue.`,
    `2. Payment Terms: ${data.paymentTerms ?? "NET 30"}.`,
    "3. Delivery schedule is subject to confirmation upon order placement.",
    "4. Prices quoted are in Ringgit Malaysia (RM) and exclude SST unless stated otherwise.",
    "5. Any changes to specifications after order confirmation may result in price revision.",
    "6. Hookka Industries Sdn Bhd reserves the right to revise prices without prior notice.",
  ];
  for (const term of terms) {
    if (y > pageH - 40) { doc.addPage(); y = margin; }
    doc.text(term, margin, y, { maxWidth: pageW - margin * 2 });
    y += 4;
  }

  // --- Signature Lines ---
  y += 10;
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
  doc.text("Customer Acceptance", sigRightX, y + 20);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  doc.text(COMPANY_NAME, sigLeftX, y + 24);
  doc.text("Name / Signature / Company Stamp", sigRightX, y + 24);

  doc.line(sigRightX, y + 30, sigRightX + sigWidth, y + 30);
  doc.text("Date", sigRightX, y + 34);

  // --- Footer ---
  const footerY = pageH - 10;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${COMPANY_NAME}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${data.quotationNo ?? "Quotation"}.pdf`);
}
