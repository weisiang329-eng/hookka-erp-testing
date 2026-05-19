import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import {
  fmtCurrency,
  fmtRM,
  fmtDate,
  amountInWords,
  addHookkaLetterhead,
} from "@/lib/pdf-utils";

// Read-only print enrichment from GET /api/invoices/:id/print-extras.
// All optional — the PDF still renders if not supplied.
export type InvoicePrintExtras = {
  customerSO?: string;
  customerRef?: string;
  // Price build-up by productCode (base / divan / leg / special order).
  // It lives on sales_order_items, read back at print time.
  priceByCode?: Record<
    string,
    {
      baseSen: number;
      divanSen: number;
      legSen: number;
      specialSen: number;
      unitSen: number;
    }
  >;
};

// Greyscale only — colour ink is expensive on the floor printer, so the
// whole document is black + greys (matches the Delivery Order model).
const INK: [number, number, number] = [17, 17, 17];
const RULE: [number, number, number] = [0, 0, 0];
const HAIR: [number, number, number] = [120, 120, 120];
const BAND: [number, number, number] = [232, 232, 232];
const FAINT: [number, number, number] = [110, 110, 110];

// Print order: bedframes first, then sofas, accessories, then services.
const catRank = (cat?: string | null): number => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return 0;
  if (c === "SOFA") return 1;
  if (c === "ACCESSORY") return 2;
  if (c === "SERVICE") return 3;
  return 4;
};
const catLabel = (cat?: string | null): string => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return "BEDFRAME";
  if (c === "SOFA") return "SOFA";
  if (c === "ACCESSORY") return "ACCESSORY / ADD-ON";
  if (c === "SERVICE") return "SERVICE";
  return "ITEMS";
};

// Invoice items don't carry a category, so infer one from the product
// name / code keywords purely for the section banding (best-effort —
// unknowns fall under a single "ITEMS" band, same as the DO).
function guessCat(productName: string, productCode: string): string {
  const s = `${productName} ${productCode}`.toUpperCase();
  if (/\bSOFA\b|\bSEATER\b|\bRECLINER\b|\bCOUCH\b/.test(s)) return "SOFA";
  if (
    /\bBED\b|BEDFRAME|DIVAN|HEADBOARD|\bHB\b|\bFRAME\b|MATTRESS/.test(s)
  )
    return "BEDFRAME";
  if (/SERVICE|DELIVERY|TRANSPORT|LABOUR|INSTALLATION|REPAIR/.test(s))
    return "SERVICE";
  if (/\bLEG\b|\bACCESSOR|ADD-?ON|PILLOW|TOPPER|PROTECTOR/.test(s))
    return "ACCESSORY";
  return "";
}

// Stacked Description cell — the standard furniture line shape:
//   line 1  product code              e.g. 2008(A)-(K)
//   line 2  product name              e.g. TRION(A) BEDFRAME (6FT)
//   line 3  build spec               Fabric / Size: 28
// (PO / SO / Reference are their own leading column, not in here.)
function describe(it: {
  productCode: string;
  productName: string;
  fabricCode: string;
  sizeLabel: string;
}): string {
  const lines: string[] = [];
  if (it.productCode) lines.push(it.productCode);
  if (it.productName) lines.push(it.productName);
  const spec: string[] = [];
  if (it.fabricCode) spec.push(it.fabricCode);
  if (it.sizeLabel) spec.push(`Size: ${it.sizeLabel}`);
  if (spec.length) lines.push(spec.join(" / "));
  return lines.join("\n");
}

// Build the stacked Price cell from the price build-up — Base, then any
// non-zero Divan / Leg / Special order add-ons on their own rows. Falls
// back to the single unit price when no build-up is available.
function priceLines(
  code: string,
  unitPriceSen: number,
  extras?: InvoicePrintExtras,
): string {
  const p = extras?.priceByCode?.[code];
  if (!p) return fmtCurrency(unitPriceSen || 0);
  const rows: string[] = [];
  rows.push(`Base ${fmtCurrency(p.baseSen || 0)}`);
  if (p.divanSen) rows.push(`+ Divan ${fmtCurrency(p.divanSen)}`);
  if (p.legSen) rows.push(`+ Leg ${fmtCurrency(p.legSen)}`);
  if (p.specialSen) rows.push(`+ Special ${fmtCurrency(p.specialSen)}`);
  if (rows.length === 1 && (p.unitSen || unitPriceSen)) {
    // Nothing but a base — show the effective unit price plainly.
    return fmtCurrency(p.unitSen || unitPriceSen || 0);
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Invoice PDF — A4 PORTRAIT, black & white, mirroring the Delivery Order
// model: premium B/W letterhead + reference block, an Order column
// (stacked PO / SO / REF), a stacked Description, category section bands,
// then Set | Price | Total Price. Letterhead + reference + column header
// repeat on every page.
// ---------------------------------------------------------------------------
export function generateInvoicePdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoice: any,
  extras?: InvoicePrintExtras,
  // "download" = save the file (default); "view" = open on screen.
  mode: "download" | "view" = "download",
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 14;
  const co = COMPANY.HOOKKA;
  const companyName = invoice.companyName || co.name;

  const docDate = fmtDate(invoice.invoiceDate);
  const billAddress =
    invoice.customerAddress || invoice.customerState || "";
  const attention = invoice.attention || "";
  const custPhone = invoice.customerPhone || "";

  // Customer order refs for the leading Order column. Invoices are
  // per-SO, so the same refs apply to every line.
  const custPO =
    (invoice.customerPO && String(invoice.customerPO).trim()) || "";
  const custSO =
    (extras?.customerSO && String(extras.customerSO).trim()) ||
    (invoice.soRef && String(invoice.soRef).trim()) ||
    (invoice.companySOId && String(invoice.companySOId).trim()) ||
    "";
  const custRef =
    (extras?.customerRef && String(extras.customerRef).trim()) ||
    (invoice.doRef && String(invoice.doRef).trim()) ||
    (invoice.doNo && String(invoice.doNo).trim()) ||
    "";
  const refLines = [
    `PO: ${custPO || "-"}`,
    `SO: ${custSO || "-"}`,
    `REF: ${custRef || "-"}`,
  ].join("\n");

  const terms = invoice.terms || "NET 30";

  const HEADER_BOTTOM = 72;
  const drawHeader = () => {
    // --- B/W letterhead: logo left, company block beside, title right ---
    addHookkaLetterhead(doc, m, 12, 12);
    const tx = m + 12 * (2038 / 907) + 5;
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(companyName, tx, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(...FAINT);
    doc.text(`Reg. ${co.regNo}   |   TIN ${co.tin}`, tx, 20.5);
    doc.text(co.address, tx, 24);
    doc.text(`Tel ${co.phone}   |   ${co.email}`, tx, 27.5);

    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.text("INVOICE", pageW - m, 17, { align: "right" });
    doc.setFontSize(10.5);
    doc.text(`No. ${invoice.invoiceNo || "-"}`, pageW - m, 23, {
      align: "right",
    });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...FAINT);
    doc.text(`${docDate}   |   ${terms}`, pageW - m, 27.5, {
      align: "right",
    });

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, 31, pageW - m, 31);

    // --- Reference block ---
    const labelW = 23;
    const lblVal = (
      x: number,
      y: number,
      k: string,
      v: string,
      maxW: number,
    ): number => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...FAINT);
      doc.text(k, x, y);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...INK);
      const lines = doc.splitTextToSize(v || "-", maxW);
      doc.text(lines, x + labelW, y);
      return y + Math.max(1, lines.length) * 4.3 + 0.8;
    };

    const leftX = m;
    const leftMaxW = (pageW - m * 2) * 0.55 - labelW;
    let ly = 38;
    ly = lblVal(leftX, ly, "Bill To", invoice.customerName || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Address", billAddress || "-", leftMaxW);
    lblVal(
      leftX,
      ly,
      "Contact",
      `${attention || "-"}${custPhone ? ` (${custPhone})` : ""}`,
      leftMaxW,
    );

    const rightX = pageW / 2 + 12;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 38;
    ry = lblVal(rightX, ry, "Invoice No.", invoice.invoiceNo || "-", rightMaxW);
    // DO No. — the invoice is billed against a delivery order; the
    // operator needs it on the page to reconcile invoice ↔ DO.
    ry = lblVal(
      rightX,
      ry,
      "DO No.",
      invoice.doNo || invoice.doRef || "-",
      rightMaxW,
    );
    ry = lblVal(rightX, ry, "Date", docDate, rightMaxW);
    ry = lblVal(rightX, ry, "Terms", terms, rightMaxW);
    lblVal(rightX, ry, "Due Date", fmtDate(invoice.dueDate), rightMaxW);

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = invoice.items || [];

  // Grand totals for the footer row.
  let totalSets = 0;
  for (const it of items) totalSets += Number(it.quantity) || 0;

  const ordered = items
    .map((it, i) => ({
      it,
      i,
      cat: guessCat(
        String(it.productName || it.description || ""),
        String(it.productCode || ""),
      ),
    }))
    .sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.i - b.i);

  const body: RowInput[] = [];
  let lastCat: string | null = null;
  for (const { it, cat } of ordered) {
    if (cat !== lastCat) {
      body.push([
        {
          content: catLabel(cat),
          colSpan: 5,
          styles: {
            fontStyle: "bold",
            fontSize: 8,
            fillColor: BAND,
            textColor: INK,
            halign: "left",
          },
        },
      ]);
      lastCat = cat;
    }
    const code = String(it.productCode || "");
    const desc = describe({
      productCode: code,
      productName: String(it.productName || it.description || ""),
      fabricCode: String(it.fabricCode || ""),
      sizeLabel: String(it.sizeLabel || ""),
    });
    body.push([
      refLines,
      desc,
      String(it.quantity ?? ""),
      priceLines(code, Number(it.unitPriceSen) || 0, extras),
      fmtCurrency(Number(it.totalSen) || 0),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    // Header halign per column matches the body so nothing looks
    // crooked (Set centred, Price / Total Price right).
    head: [
      [
        { content: "Order" },
        { content: "Description" },
        { content: "Set", styles: { halign: "center" } },
        { content: "Price (RM)", styles: { halign: "right" } },
        { content: "Total Price (RM)", styles: { halign: "right" } },
      ],
    ],
    body,
    foot: [
      [
        { content: "Total", colSpan: 2, styles: { halign: "right" } },
        { content: `${totalSets} SETS`, styles: { halign: "center" } },
        { content: "Subtotal", styles: { halign: "right" } },
        {
          content: fmtCurrency(
            Number(invoice.subtotalSen) || Number(invoice.totalSen) || 0,
          ),
          styles: { halign: "right" },
        },
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    // Never split one item's stacked cell across a page break.
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: INK,
      lineColor: HAIR,
      lineWidth: 0,
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 7,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: RULE,
    },
    footStyles: {
      fontStyle: "bold",
      fontSize: 6.6,
      overflow: "visible",
      lineWidth: { top: 0.5, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      0: { cellWidth: 32 }, // Order — stacked PO / SO / REF
      1: { cellWidth: "auto" }, // Description (code / name / spec)
      2: { cellWidth: 16, halign: "center" }, // Set
      3: { cellWidth: 40, halign: "right" }, // Price build-up
      4: { cellWidth: 26, halign: "right" }, // Total Price
    },
    didParseCell: (data) => {
      if (
        data.section === "body" &&
        data.column.index === 1 &&
        typeof data.cell.raw === "string"
      ) {
        data.cell.styles.fontSize = 7.6;
      }
      if (data.section === "body" && data.column.index === 4) {
        data.cell.styles.fontStyle = "bold";
      }
    },
    didDrawCell: (data) => {
      // Thin dashed separator under every item row.
      if (data.section === "body" && data.column.index === 4) {
        const y = data.cell.y + data.cell.height;
        doc.setDrawColor(...HAIR);
        doc.setLineWidth(0.1);
        doc.setLineDashPattern([0.7, 0.7], 0);
        doc.line(m, y, pageW - m, y);
        doc.setLineDashPattern([], 0);
      }
    },
    didDrawPage: () => {
      drawHeader();
    },
  });

  if (
    typeof (doc as unknown as { putTotalPages?: unknown }).putTotalPages ===
    "function"
  ) {
    (doc as unknown as { putTotalPages: (t: string) => void }).putTotalPages(
      "{tp}",
    );
  }

  const afterY =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;

  // --- Financial summary (Subtotal / Tax / Total + amount in words) ---
  let y = afterY + 8;
  if (y > pageH - 70) {
    doc.addPage();
    y = 36;
  }
  // Label + amount sit as a tight right-aligned pair (label ends just
  // left of the amount) so nothing drifts apart across the page.
  const valX = pageW - m;
  const lblX = pageW - m - 42;
  const sumLine = (label: string, value: string, bold: boolean, big = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(big ? 11 : 8.5);
    doc.setTextColor(...(bold ? INK : FAINT));
    doc.text(label, lblX, y, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...INK);
    doc.text(value, valX, y, { align: "right" });
    y += big ? 8 : 6;
  };
  // Subtotal already prints in the table footer (column-aligned under
  // Total Price). Only repeat it here when there's tax / discount to
  // chain into the TOTAL — otherwise it's just noise.
  const hasAdj =
    !!Number(invoice.taxSen) || !!Number(invoice.discountSen);
  if (hasAdj) {
    sumLine("Subtotal", fmtRM(Number(invoice.subtotalSen) || 0), false);
    if (Number(invoice.taxSen)) {
      sumLine("Tax", fmtRM(Number(invoice.taxSen)), false);
    }
    if (Number(invoice.discountSen)) {
      sumLine("Discount", `- ${fmtRM(Number(invoice.discountSen))}`, false);
    }
  }
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.4);
  doc.line(lblX - 2, y - 3, valX, y - 3);
  sumLine("TOTAL", fmtRM(Number(invoice.totalSen) || 0), true, true);

  // Amount in words.
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7.5);
  doc.setTextColor(...FAINT);
  const words = doc.splitTextToSize(
    amountInWords(Number(invoice.totalSen) || 0),
    pageW - m * 2,
  );
  doc.text(words, m, y);
  y += words.length * 4 + 6;

  // --- Bank details ---
  if (y > pageH - 60) {
    doc.addPage();
    y = 36;
  }
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.3);
  doc.rect(m, y, pageW - m * 2, 26, "S");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text("BANK DETAILS", m + 4, y + 6);
  const bankFields: [string, string][] = [
    ["Bank", "CIMB Bank Berhad"],
    ["Account Name", co.name],
    ["Account No", "8012345678"],
  ];
  let bY = y + 11;
  doc.setFontSize(7.5);
  for (const [label, value] of bankFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...FAINT);
    doc.text(label, m + 4, bY);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...INK);
    doc.text(value, m + 36, bY);
    bY += 4.6;
  }
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.8);
  doc.setTextColor(...FAINT);
  doc.text(
    "Please make payment within the stated terms.",
    pageW - m - 4,
    y + 22,
    { align: "right" },
  );
  y += 34;

  // --- Terms & Conditions ---
  // An invoice must still carry its terms — payment window, title of
  // goods, late-payment and dispute clauses (Wei Siang).
  const termsList = [
    `1. Payment is due within the stated terms (${terms}) from the invoice date.`,
    "2. Goods sold remain the property of Hookka Industries Sdn Bhd until paid in full.",
    "3. Goods delivered in good order are not returnable unless agreed in writing.",
    "4. Any discrepancy must be reported in writing within 7 days of delivery.",
    "5. Late payment may incur a 1.5% monthly charge on the overdue balance.",
    "6. All prices are in Ringgit Malaysia (RM). This invoice is subject to the standard terms of Hookka Industries Sdn Bhd.",
  ];
  const tcLineH = 3.6;
  const tcBlockH = 6 + termsList.length * tcLineH;
  if (y + tcBlockH > pageH - 38) {
    doc.addPage();
    y = 36;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...INK);
  doc.text("TERMS & CONDITIONS", m, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.6);
  doc.setTextColor(...FAINT);
  for (const t of termsList) {
    const ln = doc.splitTextToSize(t, pageW - m * 2);
    doc.text(ln, m, y);
    y += ln.length * tcLineH;
  }
  y += 6;

  // --- Signature strip ---
  if (y > pageH - 34) {
    doc.addPage();
    y = 36;
  }
  const halfW = (pageW - m * 2 - 14) / 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.3);
  doc.line(m, y + 14, m + halfW, y + 14);
  doc.line(pageW - m - halfW, y + 14, pageW - m, y + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text("Prepared By", m, y + 19);
  doc.text("Received By", pageW - m - halfW, y + 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...FAINT);
  doc.text(companyName, m, y + 23.5);
  doc.text("Customer Stamp & Signature", pageW - m - halfW, y + 23.5);

  // --- Page footers (all pages) ---
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = pageH - 9;
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.3);
    doc.line(m, fy - 4, pageW - m, fy - 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...FAINT);
    doc.text(
      `${companyName} · ${co.regNo} · Computer-generated invoice`,
      m,
      fy,
    );
    doc.text(`Page ${p} of ${pages}`, pageW - m, fy, { align: "right" });
  }

  const fileName = `INV-${invoice.invoiceNo || "INVOICE"}.pdf`;
  if (mode === "view") {
    try {
      const url = doc.output("bloburl");
      const w = window.open(String(url), "_blank");
      if (!w) doc.save(fileName);
    } catch {
      doc.save(fileName);
    }
    return;
  }
  doc.save(fileName);
}
