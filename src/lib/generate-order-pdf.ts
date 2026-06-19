// ---------------------------------------------------------------------------
// Shared SO + CO PDF renderer. generate-so-pdf.ts and generate-co-pdf.ts are
// thin wrappers over this — they map their respective row types into the
// normalized BaseOrderForPdf + supply an OrderPdfVariant config that names
// the document, the company-side ID, the customer-side reference rows, and
// the filename.
//
// Closes DUP-005 in bug_audit_duplicate_logic.md — the two PDF files used to
// be 460 lines each with ~452 identical lines (verified by `diff` 2026-05-09).
// Layout / surcharge rendering / letterhead / totals lived in lockstep but
// were copy-pasted, so any visual tweak risked drifting one document away
// from the other. After this extraction, only the variant config differs.
//
// BODY STYLING aligns to the Delivery Order / Invoice family (owner ruling:
// "单据统一用 DO/SI 的现代版当标准，把 SO/CO 拉过来") — same shared letterhead,
// the same FAINT/INK two-column reference block, the same bronze section
// labels + plain-theme item table (hairline grid, dashed row separators),
// and the same right-aligned totals + amount-in-words block. ALL of the
// SO/CO's own content (unit prices, divan/leg/special build-up, amount in
// words, terms, three signatures) is preserved — only the look changed.
// ---------------------------------------------------------------------------
import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import type { Customer } from "@/lib/mock-data";
import { COMPANY } from "@/lib/constants";
import {
  fmtCurrency,
  fmtRM,
  fmtDate,
  amountInWords,
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  PDF,
} from "@/lib/pdf-utils";

const CO = COMPANY.HOOKKA;

// Minimal surface the renderer needs from each line item. Both
// SalesOrderItem and ConsignmentOrderItem already match this shape — see
// the wrappers in generate-so-pdf.ts / generate-co-pdf.ts.
export type OrderItemForPdf = {
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
  quantity: number;
};

// The shared renderer's input shape. Fields that genuinely differ between
// SO and CO (header title, document number, document date, customer-ref
// rows, filename) live on OrderPdfVariant, not here.
export type BaseOrderForPdf = {
  customerName: string;
  customerState?: string | null;
  reference?: string | null;
  customerDeliveryDate?: string | null;
  status: string;
  notes?: string | null;
  subtotalSen: number;
  totalSen: number;
  items: OrderItemForPdf[];
};

export type OrderPdfVariant = {
  /** Header title rendered top-right, all-caps. */
  title: string;
  /** Bold document number under the title (companySOId / companyCOId). */
  documentNumber: string;
  /** Date label value for the ORDER DETAILS box. */
  documentDate: string | null;
  /**
   * Customer reference rows for the ORDER DETAILS box. SO has two entries
   * (Customer PO + Customer SO); CO has one (Customer CO). Empty array is
   * legal — the surrounding "Date / Reference / Delivery Date / Terms /
   * Status" rows render unconditionally.
   */
  customerRefRows: [label: string, value: string][];
  /** File save name (without extension). */
  filename: string;
};

export function generateOrderPdf(
  order: BaseOrderForPdf,
  customer: Customer | null | undefined,
  variant: OrderPdfVariant,
  // returnDoc: hand back the built jsPDF instead of saving it — lets the bulk
  // "Download PDF" action merge several orders into one file (see merge-pdf.ts).
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pw = doc.internal.pageSize.getWidth(); // 210
  const ph = doc.internal.pageSize.getHeight(); // 297
  // Align to the DO/SI family margin (14mm) so the whole document set frames
  // identically.
  const m = PDF.margin; // 14
  const cw = pw - m * 2; // content width

  // Resolve hub for delivery address
  const hub = customer?.deliveryHubs?.find(h => h.state === order.customerState)
    || customer?.deliveryHubs?.find(h => h.isDefault)
    || customer?.deliveryHubs?.[0];

  const docDate = fmtDate(variant.documentDate);

  // ===== HEADER (shared letterhead — single source of truth across all docs) =====
  // statusText mirrors the DO/SI right-meta line (DO = "C.O.D.", SI = terms);
  // the SO/CO terms are Net 30.
  drawLetterhead(doc, {
    docTitle: variant.title,
    docNo: variant.documentNumber,
    docDate,
    statusText: "Net 30",
    company: "HOOKKA",
  });

  // ===== REFERENCE BLOCK (DO/SI lblVal two-column style) =====
  // Label in FAINT (muted) 8pt normal, value in INK bold; the left column
  // takes 55% of the content width, the right column starts at pageW/2 + 12.
  // Identical to generate-do-pdf.ts / generate-invoice-pdf.ts so the customer /
  // dates / refs band reads the same across SO / CO / DO / SI.
  const labelW = 23;
  const lblVal = (
    x: number,
    yy: number,
    k: string,
    v: string,
    maxW: number,
  ): number => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.muted);
    doc.text(k, x, yy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    const lines = doc.splitTextToSize(v || "-", maxW);
    doc.text(lines, x + labelW, yy);
    return yy + Math.max(1, lines.length) * 4.3 + 0.8;
  };

  const leftX = m;
  const leftMaxW = (pw - m * 2) * 0.55 - labelW;
  let ly = 40;
  ly = lblVal(leftX, ly, "Bill To", customer?.name || order.customerName || "-", leftMaxW);
  ly = lblVal(leftX, ly, "Address", customer?.companyAddress || "-", leftMaxW);
  ly = lblVal(
    leftX,
    ly,
    "Attention",
    customer?.contactName || hub?.contactName || "-",
    leftMaxW,
  );
  ly = lblVal(
    leftX,
    ly,
    "Contact",
    `${customer?.phone || hub?.phone || "-"}${
      customer?.email || hub?.email ? `  ·  ${customer?.email || hub?.email}` : ""
    }`,
    leftMaxW,
  );

  const rightX = pw / 2 + 12;
  const rightMaxW = pw - m - rightX - labelW;
  let ry = 40;
  // The variant's own document number row first (SO No. / CO No.), then the
  // customer-side refs, the in-house reference, delivery date, terms, status.
  ry = lblVal(rightX, ry, `${variant.title.split(" ")[0]} No.`, variant.documentNumber || "-", rightMaxW);
  ry = lblVal(rightX, ry, "Date", docDate, rightMaxW);
  for (const [label, value] of variant.customerRefRows) {
    ry = lblVal(rightX, ry, label, value || "-", rightMaxW);
  }
  ry = lblVal(rightX, ry, "Reference", order.reference || "-", rightMaxW);
  ry = lblVal(
    rightX,
    ry,
    "Delivery Date",
    order.customerDeliveryDate ? fmtDate(order.customerDeliveryDate) : "-",
    rightMaxW,
  );
  ry = lblVal(rightX, ry, "Terms", "Net 30", rightMaxW);
  lblVal(rightX, ry, "Status", order.status.replace(/_/g, " "), rightMaxW);

  let y = Math.max(ly, ry) + 2;

  // ===== DELIVERY ADDRESS (bronze section label, DO/SI house style) =====
  y = drawSectionLabel(doc, "Delivery To", y);

  const deliveryName = hub?.shortName || order.customerState || "-";
  const deliveryAddr = hub?.address || customer?.companyAddress || "To be confirmed";
  const deliveryContact = hub?.contactName || customer?.contactName || "-";
  const deliveryPhone = hub?.phone || customer?.phone || "-";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...PDF.ink);
  doc.text(deliveryName, m, y);
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF.ink);
  const addrWrapped = doc.splitTextToSize(deliveryAddr, cw);
  doc.text(addrWrapped, m, y);
  y += addrWrapped.length * 3.6 + 0.5;
  doc.setTextColor(...PDF.muted);
  doc.text(`Attn: ${deliveryContact}   |   Tel: ${deliveryPhone}`, m, y);
  y += 6;

  // ===== ITEMS (bronze section label, DO/SI house style) =====
  y = drawSectionLabel(doc, "Items", y);

  // Columns: No | Item Code | Description | Size | Fabric | Gap | Divan | Leg |
  // Qty | Unit Price (RM) | Amount (RM). The SO/CO carries far more pricing /
  // build-up detail than the DO, so its column set is preserved in full; only
  // the table THEME matches the DO/SI plain-grid look.
  const tableHead: RowInput[] = [
    [
      { content: "No", styles: { halign: "center" } },
      { content: "Item Code" },
      { content: "Description" },
      { content: "Size", styles: { halign: "center" } },
      { content: "Fabric", styles: { halign: "center" } },
      { content: "Gap", styles: { halign: "center" } },
      { content: "Divan", styles: { halign: "center" } },
      { content: "Leg", styles: { halign: "center" } },
      { content: "Qty", styles: { halign: "center" } },
      { content: "Unit Price\n(RM)", styles: { halign: "right" } },
      { content: "Amount\n(RM)", styles: { halign: "right" } },
    ],
  ];
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
        `Base: ${fmtCurrency(item.basePriceSen)}`,
        "",
      ]);
      rowTags.push("main");

      // Charge sub-rows
      for (const ch of charges) {
        tableBody.push(["", "", `   + ${ch.label}`, "", "", "", "", "", "", `+ ${fmtCurrency(ch.amount)}`, ""]);
        rowTags.push("charge");
      }

      // Total row: shows final unit price + line total
      tableBody.push(["", "", "", "", "", "", "", "", "", `= ${fmtCurrency(item.unitPriceSen)}`, fmtCurrency(item.lineTotalSen)]);
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
        fmtCurrency(item.unitPriceSen),
        fmtCurrency(item.lineTotalSen),
      ]);
      rowTags.push("main");
    }
  });

  autoTable(doc, {
    startY: y,
    margin: { left: m, right: m, bottom: 16 },
    head: tableHead,
    body: tableBody,
    // DO/SI house theme: plain grid, white header with a black underline rule,
    // hairline body lines, dashed per-row separators. Matches generate-do-pdf
    // and generate-invoice-pdf exactly.
    theme: "plain",
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica",
      fontSize: 6.5,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: PDF.ink,
      lineColor: PDF.rule,
      lineWidth: 0,
      overflow: "linebreak",
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 6.8,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: PDF.ink,
      valign: "middle",
    },
    columnStyles: {
      0: { cellWidth: 7, halign: "center" },        // No
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
      if (data.section !== "body") return;
      const tag = rowTags[data.row.index];
      if (tag === "charge") {
        // Surcharge sub-rows: muted italic
        data.cell.styles.textColor = PDF.muted;
        data.cell.styles.fontStyle = "italic";
      } else if (tag === "total") {
        // Total row: bold ink for the price columns, hide the empty cells
        if (data.column.index === 9 || data.column.index === 10) {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = PDF.ink;
        } else {
          data.cell.styles.textColor = [220, 220, 220];
        }
      }
    },
    didDrawCell(data) {
      // Thin dashed separator under every main item row (drawn once on the
      // last column) — the DO/SI per-row separator. Sub-rows (charge / total)
      // belong to the row above, so only the "total"/standalone "main" row
      // that closes a line gets the rule.
      if (data.section !== "body" || data.column.index !== 10) return;
      const tag = rowTags[data.row.index];
      const next = rowTags[data.row.index + 1];
      // Draw the separator at the END of a logical item: a standalone main row
      // (no following charge/total) or the total row that closes a build-up.
      const closesItem =
        tag === "total" || (tag === "main" && next !== "charge" && next !== "total");
      if (!closesItem) return;
      const yy = data.cell.y + data.cell.height;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.1);
      doc.setLineDashPattern([0.7, 0.7], 0);
      doc.line(m, yy, pw - m, yy);
      doc.setLineDashPattern([], 0);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY;

  // ===== TOTALS (DO/SI right-aligned label + value pairs) =====
  y += 8;
  if (y > ph - 70) {
    doc.addPage();
    y = 36;
  }
  const valX = pw - m;
  const lblX = pw - m - 42;
  const sumLine = (label: string, value: string, bold: boolean, big = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(big ? 11 : 8.5);
    doc.setTextColor(...(bold ? PDF.ink : PDF.muted));
    doc.text(label, lblX, y, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    doc.text(value, valX, y, { align: "right" });
    y += big ? 8 : 6;
  };

  sumLine("Subtotal", fmtRM(order.subtotalSen), false);
  const discSen = order.subtotalSen - order.totalSen;
  if (discSen > 0) {
    sumLine("Discount", `- ${fmtRM(discSen)}`, false);
  }
  // Rule clears the 11pt TOTAL cap height (matches the invoice spacing).
  y += 3;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.4);
  doc.line(lblX - 2, y - 5.5, valX, y - 5.5);
  sumLine("TOTAL", fmtRM(order.totalSen), true, true);

  // Amount in words (SO/CO content kept) — italic, muted, full width.
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF.muted);
  const words = doc.splitTextToSize(amountInWords(order.totalSen), cw);
  doc.text(words, m, y);
  y += words.length * 4 + 6;

  // ===== REMARKS (SO/CO content kept) =====
  if (order.notes) {
    const noteLines = doc.splitTextToSize(order.notes, cw);
    const blockH = 6 + noteLines.length * 3.6;
    if (y + blockH > ph - 38) {
      doc.addPage();
      y = 36;
    }
    y = drawSectionLabel(doc, "Remarks", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.ink);
    doc.text(noteLines, m, y);
    y += noteLines.length * 3.6 + 6;
  }

  // ===== TERMS & CONDITIONS (SO/CO content kept) =====
  // Title-case the header title ("SALES ORDER" → "Sales Order", "CONSIGNMENT
  // ORDER" → "Consignment Order") so term #5 names the right document.
  const docLabel = variant.title.replace(/\b\w+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
  const terms = [
    "1. Goods sold are not returnable or exchangeable.",
    "2. Interest of 1.5% per month will be charged on overdue accounts.",
    `3. All cheques should be crossed and made payable to ${CO.name}.`,
    "4. Goods remain the property of the seller until full payment is received.",
    `5. Any discrepancy in this ${docLabel} must be reported within 7 days.`,
  ];
  const tcLineH = 3.6;
  const tcBlockH = 6 + terms.length * tcLineH;
  if (y + tcBlockH > ph - 40) {
    doc.addPage();
    y = 36;
  }
  y = drawSectionLabel(doc, "Terms & Conditions", y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.6);
  doc.setTextColor(...PDF.muted);
  for (const t of terms) {
    const ln = doc.splitTextToSize(t, cw);
    doc.text(ln, m, y);
    y += ln.length * tcLineH;
  }
  y += 6;

  // ===== SIGNATURES (SO/CO content kept — three signatories) =====
  if (y + 26 > ph - 18) {
    doc.addPage();
    y = 36;
  }
  const sigW = (cw - 8) / 3;
  const sigPos = [m, m + sigW + 4, m + (sigW + 4) * 2];
  const sigLabels = ["Prepared By", "Checked By", "Approved By / Customer"];

  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 3; i++) {
    doc.line(sigPos[i], y + 14, sigPos[i] + sigW - 2, y + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.ink);
    doc.text(sigLabels[i], sigPos[i], y + 19);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.faint);
    doc.text("Name / Date / Stamp", sigPos[i], y + 23.5);
  }

  // ===== FOOTER (all pages — shared DO/SI footer) =====
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawDocFooter(doc, "HOOKKA");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...PDF.faint);
    doc.text(`Page ${p} of ${totalPages}`, pw - m, ph - 16, { align: "right" });
  }

  if (opts?.returnDoc) return doc;
  doc.save(`${variant.filename}.pdf`);
}
