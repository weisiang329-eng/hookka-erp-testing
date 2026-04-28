import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Customer } from "@/lib/mock-data";
import type { ConsignmentOrder } from "@/types";
import { COMPANY } from "@/lib/constants";
import { fmtCurrency as fmtRM, fmtDate, amountInWords, addHookkaLetterhead } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Company info (from constants)
// ---------------------------------------------------------------------------
const CO = COMPANY.HOOKKA;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateCOPdf(order: ConsignmentOrder, customer?: Customer | null) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pw = doc.internal.pageSize.getWidth(); // 210
  const ph = doc.internal.pageSize.getHeight(); // 297
  const m = 12; // margin
  const cw = pw - m * 2; // content width
  let y = 10;

  // Resolve hub for delivery address
  const hub = customer?.deliveryHubs?.find(h => h.state === order.customerState)
    || customer?.deliveryHubs?.find(h => h.isDefault)
    || customer?.deliveryHubs?.[0];

  // ===== HEADER =====
  // Logo (left of company text)
  addHookkaLetterhead(doc, m, y - 2, 9);
  const cx = m + 23;

  // Company name (left)
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(CO.name, cx, y + 5);

  // Reg no
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`(${CO.regNo})`, cx, y + 9);

  // Address lines
  doc.setFontSize(6.5);
  doc.setTextColor(100, 100, 100);
  let ay = y + 12.5;
  for (const line of CO.addressLines) {
    doc.text(line, cx, ay);
    ay += 3;
  }
  doc.text(`Tel: ${CO.phone}  |  Email: ${CO.email}`, cx, ay);

  // Title (right)
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("CONSIGNMENT ORDER", pw - m, y + 6, { align: "right" });

  // CO Number
  doc.setFontSize(11);
  doc.text(order.companyCOId ?? "", pw - m, y + 13, { align: "right" });

  // Double line separator
  y = 32;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(m, y, pw - m, y);
  doc.setLineWidth(0.15);
  doc.line(m, y + 1, pw - m, y + 1);
  y += 4;

  // ===== ROW: Customer (left) + Order Details (right) =====
  const halfW = (cw - 4) / 2;
  const rX = m + halfW + 4;

  // -- Customer Box --
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.2);

  // Customer header
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BILL TO", m + 1, y + 3.5);
  doc.line(m, y + 5, m + halfW, y + 5);

  // Customer fields
  const custFields: [string, string][] = [
    ["Company", customer?.name || order.customerName],
    ["Address", customer?.companyAddress || "-"],
    ["Attention", customer?.contactName || hub?.contactName || "-"],
    ["Tel", customer?.phone || hub?.phone || "-"],
    ["Email", customer?.email || hub?.email || "-"],
  ];

  let cy = y + 9;
  doc.setFontSize(7);
  for (const [label, val] of custFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, m + 1, cy);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    // Wrap long addresses
    if (label === "Address") {
      const wrapped = doc.splitTextToSize(": " + val, halfW - 28);
      doc.text(wrapped, m + 22, cy);
      cy += (wrapped.length - 1) * 3;
    } else {
      doc.text(": " + val, m + 22, cy);
    }
    cy += 4.2;
  }
  const custBoxH = cy - y + 1;
  doc.rect(m, y, halfW, custBoxH);

  // -- Order Details Box --
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("ORDER DETAILS", rX + 1, y + 3.5);
  doc.line(rX, y + 5, rX + halfW, y + 5);

  const orderFields: [string, string][] = [
    ["Date", fmtDate(order.companyCODate)],
    ["Customer CO", order.customerCOId || "-"],
    ["Reference", order.reference || "-"],
    ["Delivery Date", order.customerDeliveryDate ? fmtDate(order.customerDeliveryDate) : "-"],
    ["Terms", "Net 30"],
    ["Status", order.status.replace(/_/g, " ")],
  ];

  let oy = y + 9;
  doc.setFontSize(7);
  for (const [label, val] of orderFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, rX + 1, oy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(": " + val, rX + 26, oy);
    oy += 4.2;
  }

  const orderBoxH = Math.max(custBoxH, oy - y + 1);
  doc.rect(rX, y, halfW, orderBoxH);

  y += Math.max(custBoxH, orderBoxH) + 3;

  // ===== DELIVERY ADDRESS =====
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.2);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("DELIVERY TO", m + 1, y + 3.5);
  doc.line(m, y + 5, m + cw, y + 5);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(30, 30, 30);

  let dy = y + 9;
  const deliveryName = hub?.shortName || order.customerState || "-";
  const deliveryAddr = hub?.address || customer?.companyAddress || "To be confirmed";
  const deliveryContact = hub?.contactName || customer?.contactName || "-";
  const deliveryPhone = hub?.phone || customer?.phone || "-";

  doc.setFont("helvetica", "bold");
  doc.text(deliveryName, m + 1, dy);
  doc.setFont("helvetica", "normal");
  dy += 3.5;

  const addrWrapped = doc.splitTextToSize(deliveryAddr, cw - 4);
  doc.text(addrWrapped, m + 1, dy);
  dy += addrWrapped.length * 3;

  doc.setTextColor(100, 100, 100);
  doc.text(`Attn: ${deliveryContact}  |  Tel: ${deliveryPhone}`, m + 1, dy + 1);
  dy += 4;

  const delivBoxH = dy - y + 1;
  doc.rect(m, y, cw, delivBoxH);
  y += delivBoxH + 3;

  // ===== ITEMS TABLE =====
  // Columns: No | Item Code | Description | Size | Fabric | Gap | Divan | Leg | Qty | Unit Price (RM) | Amount (RM)
  // If unit price differs from base price, show price breakdown sub-rows

  const tableHead = [["No", "Item Code", "Description", "Size", "Fabric", "Gap", "Divan", "Leg", "Qty", "Unit Price\n(RM)", "Amount\n(RM)"]];
  // Tag each row: "main" | "charge" | "total" for styling
  const rowTags: string[] = [];
  const tableBody: (string | number)[][] = [];

  order.items.forEach((item, idx) => {
    const hasSurcharge = item.unitPriceSen !== item.basePriceSen;

    // Compute individual surcharges; if individual fields are 0 but
    // unitPriceSen > basePriceSen, show the difference as "Customization"
    const charges: { label: string; amount: number }[] = [];
    if (item.divanHeightInches && item.divanPriceSen > 0) {
      charges.push({ label: `Divan ${item.divanHeightInches}" surcharge`, amount: item.divanPriceSen });
    }
    if (item.legHeightInches && item.legPriceSen > 0) {
      charges.push({ label: `Leg ${item.legHeightInches}" surcharge`, amount: item.legPriceSen });
    }
    if (item.specialOrder && item.specialOrderPriceSen > 0) {
      charges.push({ label: item.specialOrder.replace(/_/g, " "), amount: item.specialOrderPriceSen });
    }
    // If there's still an unexplained difference, show it
    const explainedSurcharge = charges.reduce((s, c) => s + c.amount, 0);
    const unexplained = item.unitPriceSen - item.basePriceSen - explainedSurcharge;
    if (unexplained > 0) {
      charges.push({ label: "Customization surcharge", amount: unexplained });
    }

    if (hasSurcharge && charges.length > 0) {
      // Row 1: product info + base price (no amount yet)
      tableBody.push([
        String(idx + 1),
        item.productCode,
        item.productName,
        item.sizeLabel,
        item.fabricCode,
        item.gapInches ? `${item.gapInches}"` : "-",
        item.divanHeightInches ? `${item.divanHeightInches}"` : "-",
        item.legHeightInches ? `${item.legHeightInches}"` : "-",
        String(item.quantity),
        `Base: ${fmtRM(item.basePriceSen)}`,
        "",
      ]);
      rowTags.push("main");

      // Charge sub-rows
      for (const ch of charges) {
        tableBody.push(["", "", `   + ${ch.label}`, "", "", "", "", "", "", `+ ${fmtRM(ch.amount)}`, ""]);
        rowTags.push("charge");
      }

      // Total row: shows final unit price + line total
      tableBody.push(["", "", "", "", "", "", "", "", "", `= ${fmtRM(item.unitPriceSen)}`, fmtRM(item.lineTotalSen)]);
      rowTags.push("total");
    } else {
      // Simple row: no surcharges, show unit price + amount directly
      tableBody.push([
        String(idx + 1),
        item.productCode,
        item.productName,
        item.sizeLabel,
        item.fabricCode,
        item.gapInches ? `${item.gapInches}"` : "-",
        item.divanHeightInches ? `${item.divanHeightInches}"` : "-",
        item.legHeightInches ? `${item.legHeightInches}"` : "-",
        String(item.quantity),
        fmtRM(item.unitPriceSen),
        fmtRM(item.lineTotalSen),
      ]);
      rowTags.push("main");
    }
  });

  autoTable(doc, {
    startY: y,
    margin: { left: m, right: m },
    head: tableHead,
    body: tableBody,
    theme: "grid",
    styles: {
      fontSize: 6.5,
      cellPadding: 1.5,
      textColor: [30, 30, 30],
      lineColor: [160, 160, 160],
      lineWidth: 0.2,
      font: "helvetica",
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 6.5,
      fontStyle: "bold",
      halign: "center",
      valign: "middle",
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
    columnStyles: {
      0: { cellWidth: 7, halign: "center" },       // No
      1: { cellWidth: 18, fontStyle: "bold" },      // Item Code
      2: { cellWidth: "auto" },                      // Description
      3: { cellWidth: 12, halign: "center" },       // Size
      4: { cellWidth: 16, halign: "center" },       // Fabric
      5: { cellWidth: 10, halign: "center" },       // Gap
      6: { cellWidth: 10, halign: "center" },       // Divan
      7: { cellWidth: 10, halign: "center" },       // Leg
      8: { cellWidth: 8, halign: "center" },        // Qty
      9: { cellWidth: 22, halign: "right" },        // Unit Price
      10: { cellWidth: 22, halign: "right", fontStyle: "bold" }, // Amount
    },
    didParseCell(data) {
      // Right-align price headers
      if (data.section === "head" && (data.column.index === 9 || data.column.index === 10)) {
        data.cell.styles.halign = "right";
      }
      if (data.section !== "body") return;
      const tag = rowTags[data.row.index];
      if (tag === "charge") {
        // Surcharge rows: gray italic
        data.cell.styles.textColor = [100, 100, 100];
        data.cell.styles.fontStyle = "italic";
      } else if (tag === "total") {
        // Total row: bold black for price columns
        if (data.column.index === 9 || data.column.index === 10) {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = [0, 0, 0];
        } else {
          data.cell.styles.textColor = [200, 200, 200]; // hide empty cells
        }
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY;

  // ===== TOTALS =====
  const tW = 65;
  const tX = pw - m - tW;

  if (y + 55 > ph - 25) { doc.addPage(); y = 15; }

  y += 2;
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.2);

  // Subtotal
  doc.rect(tX, y, tW, 5.5);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Subtotal", tX + 2, y + 4);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(fmtRM(order.subtotalSen), pw - m - 2, y + 4, { align: "right" });
  y += 5.5;

  // Discount
  const discSen = order.subtotalSen - order.totalSen;
  doc.rect(tX, y, tW, 5.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("Discount", tX + 2, y + 4);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(discSen > 0 ? "(" + fmtRM(discSen) + ")" : "-", pw - m - 2, y + 4, { align: "right" });
  y += 5.5;

  // Total — white box, heavy black border for visual emphasis (saves ink)
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.rect(tX, y, tW, 6.5, "S");
  doc.setLineWidth(0.2);
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("TOTAL (RM)", tX + 2, y + 4.8);
  doc.setFontSize(10);
  doc.text(fmtRM(order.totalSen), pw - m - 2, y + 4.8, { align: "right" });
  y += 9;

  // Amount in words
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(100, 100, 100);
  doc.text("Amount in words:", m, y + 1);
  doc.setFont("helvetica", "bolditalic");
  doc.setTextColor(30, 30, 30);
  const words = doc.splitTextToSize(amountInWords(order.totalSen), cw - 26);
  doc.text(words, m + 26, y + 1);
  y += words.length * 3 + 4;

  // ===== NOTES =====
  if (order.notes) {
    if (y + 18 > ph - 40) { doc.addPage(); y = 15; }
    doc.setDrawColor(160, 160, 160);
    doc.rect(m, y, cw, 12);
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("REMARKS:", m + 2, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);
    doc.text(order.notes, m + 2, y + 8, { maxWidth: cw - 4 });
    y += 15;
  }

  // ===== TERMS =====
  if (y + 20 > ph - 40) { doc.addPage(); y = 15; }
  y += 2;
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("TERMS AND CONDITIONS:", m, y);
  y += 3.5;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(6.5);
  const terms = [
    "1. Goods sold are not returnable or exchangeable.",
    "2. Interest of 1.5% per month will be charged on overdue accounts.",
    `3. All cheques should be crossed and made payable to ${CO.name}.`,
    "4. Goods remain the property of the seller until full payment is received.",
    "5. Any discrepancy in this Sales Order must be reported within 7 days.",
  ];
  for (const t of terms) { doc.text(t, m, y); y += 3; }

  // ===== SIGNATURES =====
  if (y + 30 > ph - 15) { doc.addPage(); y = 15; }
  y += 8;
  const sigW = (cw - 8) / 3;
  const sigPos = [m, m + sigW + 4, m + (sigW + 4) * 2];
  const sigLabels = ["Prepared By", "Checked By", "Approved By / Customer"];

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  doc.setFontSize(7);
  doc.setTextColor(50, 50, 50);

  for (let i = 0; i < 3; i++) {
    doc.line(sigPos[i], y + 14, sigPos[i] + sigW - 2, y + 14);
    doc.setFont("helvetica", "normal");
    doc.text(sigLabels[i], sigPos[i], y + 18);
    doc.setFontSize(6);
    doc.setTextColor(120, 120, 120);
    doc.text("Date: _______________", sigPos[i], y + 22);
    doc.setFontSize(7);
    doc.setTextColor(50, 50, 50);
  }

  // ===== FOOTER (all pages) =====
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const fy = ph - 8;
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.15);
    doc.line(m, fy - 2, pw - m, fy - 2);
    doc.setFontSize(6);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(140, 140, 140);
    doc.text("This is a computer generated document. No signature is required.", m, fy);
    doc.text(`Page ${p} of ${totalPages}`, pw - m, fy, { align: "right" });
  }

  doc.save(`${order.companyCOId ?? order.id}.pdf`);
}
