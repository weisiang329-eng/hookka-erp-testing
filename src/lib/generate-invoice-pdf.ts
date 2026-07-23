import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import {
  fmtCurrency,
  fmtRM,
  fmtDate,
  amountInWords,
  drawLetterhead,
} from "@/lib/pdf-utils";

// Read-only print enrichment from GET /api/invoices/:id/print-extras.
// All optional — the PDF still renders if not supplied.
export type InvoiceLineExtra = {
  itemCategory?: string | null; // BEDFRAME / SOFA / ACCESSORY / SERVICE
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  totalHeightInches?: number | null;
  specialOrder?: string | null;
  baseSen: number;
  divanSen: number;
  legSen: number;
  specialSen: number;
  totalHeightSen?: number;
  unitSen: number;
  // Per-line customer references (a consolidated invoice carries a
  // different PO / customer SO / our company SO on every line).
  customerPOId?: string | null;
  customerSOLine?: string | null;
  customerRefLine?: string | null;
  companySO?: string | null;
};

export type InvoicePrintExtras = {
  customerSO?: string;
  customerRef?: string;
  // Price build-up by productCode (kept for backward-safety).
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
  // Per invoice line (keyed by invoice_items.id): the same spec + price
  // build-up the Delivery Order resolves, so the invoice description and
  // price match the DO line for line.
  items?: Record<string, InvoiceLineExtra>;
};

const num = (v?: number | null) =>
  v == null || Number(v) === 0 ? null : `${v}"`;

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

// Stacked Description cell — IDENTICAL shape to the Delivery Order:
//   line 1  product code              e.g. 2008(A)-(K)
//   line 2  product name              e.g. TRION(A) BEDFRAME (6FT)
//   line 3  build spec               PC151-01 / DIVAN 8" + 4" LEG /
//                                     GAP 12" / T.Heights 24" / <special>
// (PO / SO / Reference are their own leading column, not in here.)
function describe(
  it: {
    productCode: string;
    productName: string;
    fabricCode: string;
    sizeLabel: string;
  },
  ex: InvoiceLineExtra | undefined,
): string {
  const lines: string[] = [];
  if (it.productCode) lines.push(it.productCode);
  if (it.productName) lines.push(it.productName);

  const cat = (ex?.itemCategory || "").toUpperCase();
  const dv = num(ex?.divanHeightInches);
  const lg = num(ex?.legHeightInches);
  const gp = num(ex?.gapInches);
  const th = num(ex?.totalHeightInches);
  const spec: string[] = [];
  if (it.fabricCode) spec.push(it.fabricCode);

  // Bedframe-style spec whenever it's tagged BEDFRAME OR carries a
  // divan / leg / gap / total-height value — so the build spec prints
  // even when itemCategory was never stamped (same rule as the DO).
  const hasBfSpec = !!(dv || lg || gp || th);
  if (
    cat === "BEDFRAME" ||
    (cat !== "SOFA" && cat !== "ACCESSORY" && hasBfSpec)
  ) {
    if (dv) spec.push(`DIVAN ${dv}${lg ? ` + ${lg} LEG` : " + NO LEG"}`);
    else if (lg) spec.push(`${lg} LEG`);
    if (gp) spec.push(`GAP ${gp}`);
    if (th) spec.push(`T.Heights ${th}`);
  } else {
    // sofa / accessory: no T.Heights — total height is a bedframe-only
    // concept (divan + gap + leg). A stray value must not print on sofas.
    // — Wei Siang 2026-05-29
    if (it.sizeLabel) spec.push(`Size: ${it.sizeLabel}`);
    if (lg) spec.push(`${lg} LEG`);
  }
  if (ex?.specialOrder && String(ex.specialOrder).trim())
    spec.push(String(ex.specialOrder).trim());
  if (spec.length) lines.push(spec.join(" / "));
  return lines.join("\n");
}

// Build the stacked Price cell — every component on its own row so the
// customer can see exactly how the price is built up and what is being
// charged for: Base, then Divan / Leg / Special order whenever each is
// separately priced. Falls back to the single unit price when no
// build-up is available.
function priceLines(
  unitPriceSen: number,
  ex: InvoiceLineExtra | undefined,
): string {
  if (!ex) return fmtCurrency(unitPriceSen || 0);
  const rows: string[] = [`Base ${fmtCurrency(ex.baseSen || 0)}`];
  if (ex.divanSen) rows.push(`+ Divan ${fmtCurrency(ex.divanSen)}`);
  if (ex.legSen) rows.push(`+ Leg ${fmtCurrency(ex.legSen)}`);
  if (ex.totalHeightSen) rows.push(`+ T.Height ${fmtCurrency(ex.totalHeightSen)}`);
  if (ex.specialSen) rows.push(`+ Special ${fmtCurrency(ex.specialSen)}`);
  if (rows.length === 1) {
    // No separately-priced add-ons — the divan / leg are built into the
    // base (their inches still print in the Description). Show the one
    // effective unit price.
    return fmtCurrency(ex.unitSen || ex.baseSen || unitPriceSen || 0);
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
// Builds the complete invoice document into a fresh jsPDF instance. Shared
// by generateInvoicePdf (save / view) and generateInvoicePdfBase64 (email
// attachment for the customer invoice notice) so every consumer renders the
// IDENTICAL document.
function buildInvoiceDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoice: any,
  extras?: InvoicePrintExtras,
): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
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

  // Order column refs are PER LINE — a consolidated invoice carries a
  // different customer PO / customer SO / our company SO on every line,
  // exactly like the DO printout. Fall back to the invoice-level values
  // only when a line couldn't be resolved.
  const invCustPO =
    (invoice.customerPO && String(invoice.customerPO).trim()) || "";
  const invCustSO =
    (extras?.customerSO && String(extras.customerSO).trim()) || "";
  const invCustRef =
    (extras?.customerRef && String(extras.customerRef).trim()) || "";
  const invCompanySO =
    (invoice.companySOId && String(invoice.companySOId).trim()) ||
    (invoice.soRef && String(invoice.soRef).trim()) ||
    "";
  const pick = (v?: string | null, fb?: string) =>
    (v && String(v).trim()) || fb || "";
  const orderRefs = (ex: InvoiceLineExtra | undefined): string =>
    [
      `PO: ${pick(ex?.customerPOId, invCustPO) || "-"}`,
      `SO: ${pick(ex?.customerSOLine, invCustSO) || "-"}`,
      `REF: ${pick(ex?.customerRefLine, invCustRef) || "-"}`,
      `CO SO: ${pick(ex?.companySO, invCompanySO) || "-"}`,
    ].join("\n");

  const terms = invoice.terms || "NET 30";

  const HEADER_BOTTOM = 72;
  const drawHeader = () => {
    // --- Shared letterhead (single source of truth across all docs) ---
    drawLetterhead(doc, {
      docTitle: "INVOICE",
      docNo: `No. ${invoice.invoiceNo || "-"}`,
      docDate,
      statusText: terms,
      companyInfo: {
        name: companyName,
        regNo: co.regNo,
        tin: co.tin,
        address: co.address,
        phone: co.phone,
        email: co.email,
      },
    });

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
    .map((it, i) => {
      const ex = extras?.items?.[String(it.id || "")];
      // Prefer the real category resolved from the sales order line
      // (same source as the DO); fall back to a keyword guess only when
      // the line couldn't be matched.
      const cat =
        (ex?.itemCategory && String(ex.itemCategory).toUpperCase()) ||
        guessCat(
          String(it.productName || it.description || ""),
          String(it.productCode || ""),
        );
      return { it, i, ex, cat };
    })
    .sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.i - b.i);

  const body: RowInput[] = [];
  let lastCat: string | null = null;
  for (const { it, ex, cat } of ordered) {
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
    const desc = describe(
      {
        productCode: code,
        productName: String(it.productName || it.description || ""),
        fabricCode: String(it.fabricCode || ""),
        sizeLabel: String(it.sizeLabel || ""),
      },
      ex,
    );
    const lineDiscountSen = Number(it.discountSen) || 0;
    const grossLineSen = (Number(it.unitPriceSen) || 0) * (Number(it.quantity) || 0);
    // When there is a per-line discount, show the gross amount first, then a
    // discount sub-row, then the net total (= it.totalSen). When no discount,
    // totalSen already equals grossLineSen — show it directly.
    body.push([
      orderRefs(ex),
      desc,
      String(it.quantity ?? ""),
      priceLines(Number(it.unitPriceSen) || 0, ex),
      fmtCurrency(lineDiscountSen > 0 ? grossLineSen : Number(it.totalSen) || 0),
    ]);
    if (lineDiscountSen > 0) {
      // Discount sub-row: muted italic, spans description; net total in last col.
      body.push([
        {
          content: "",
          styles: { textColor: FAINT },
        },
        {
          content: `Discount: - ${fmtCurrency(lineDiscountSen)}`,
          styles: { fontStyle: "italic", textColor: FAINT, fontSize: 6.8 },
        },
        { content: "", styles: { textColor: FAINT } },
        { content: "Net", styles: { fontStyle: "italic", textColor: FAINT, halign: "right" as const } },
        {
          content: fmtCurrency(Number(it.totalSen) || 0),
          styles: { fontStyle: "bold", textColor: INK },
        },
      ]);
    }
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
  // Rule sits clearly ABOVE the TOTAL line (the 11pt text rises ~2.8mm
  // over its baseline, so a y-3 rule struck through it). Add leading,
  // then draw the separator well clear of the cap height.
  y += 3;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.4);
  doc.line(lblX - 2, y - 5.5, valX, y - 5.5);
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

  return doc;
}

export function generateInvoicePdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoice: any,
  extras?: InvoicePrintExtras,
  // "download" = save the file (default); "view" = open on screen.
  mode: "download" | "view" = "download",
) {
  const doc = buildInvoiceDoc(invoice, extras);
  // invoiceNo already carries the "INV-" prefix (e.g. INV-2606-115) — don't
  // double it (was producing "INV-INV-2606-115.pdf"). Matches SO/PO/PI naming.
  const fileName = `${invoice.invoiceNo || "INVOICE"}.pdf`;
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

// Same branded invoice document, returned as a base64 string instead of
// saved/opened — feeds the customer invoice notice attachment
// (POST /api/delivery-orders/:id/notify-customer, kind "DELIVERED").
export function generateInvoicePdfBase64(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoice: any,
  extras?: InvoicePrintExtras,
): string {
  const doc = buildInvoiceDoc(invoice, extras);
  // datauristring = "data:application/pdf;filename=…;base64,<payload>".
  const uri = String(doc.output("datauristring"));
  const at = uri.indexOf("base64,");
  return at >= 0 ? uri.slice(at + "base64,".length) : "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CombinedInvoiceItem = { invoice: any; extras?: InvoicePrintExtras };

// Merge several invoices into ONE downloadable PDF (Invoices list page → bulk
// "Download PDF"). Each invoice is rendered as its OWN jsPDF first so its
// internal "Page X of Y" stays per-invoice, then pdf-lib copies every page into
// a single output document. pdf-lib is dynamically imported so it only loads
// when the bulk action actually runs.
export async function generateCombinedInvoicePdf(
  items: CombinedInvoiceItem[],
  filename = "Invoices.pdf",
): Promise<void> {
  if (items.length === 0) return;
  const docs = items.map(({ invoice, extras }) =>
    buildInvoiceDoc(invoice, extras),
  );
  const { downloadMergedPdf } = await import("./merge-pdf");
  await downloadMergedPdf(docs, filename);
}
