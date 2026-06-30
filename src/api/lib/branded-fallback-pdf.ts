// ---------------------------------------------------------------------------
// Backend-rendered BRANDED fallback PDFs for the customer-notify path
// (Delivery Order + Invoice). Uses pdf-lib so it runs on Cloudflare Workers —
// the client-side jsPDF version in src/lib/generate-do-pdf.ts / generate-
// invoice-pdf.ts cannot run here. Layout mirrors the client renderer:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ HOOKKA INDUSTRIES SDN BHD          DELIVERY ORDER        │
//   │ Reg./TIN/address/contact            DO-XXXX-YYY          │
//   ├──────────────────────────────────────────────────────────┤
//   │ Bill To / Deliver To           Doc info (date, PO, SO…)  │
//   ├──────────────────────────────────────────────────────────┤
//   │ # | Product Code | Description | Qty | Rack              │
//   │ ……                                                      │
//   │ (Invoice only: Unit Price · Amount, Subtotal/Tax/Total)  │
//   ├──────────────────────────────────────────────────────────┤
//   │ HOOKKA INDUSTRIES SDN BHD · 2026 · Computer-generated     │
//   └──────────────────────────────────────────────────────────┘
//
// Owner ruling 2026-06-30: even when the DO is for a sister company (HOUZS),
// the email + fallback PDF are SENT BY Hookka — so the letterhead + footer
// stay HOOKKA INDUSTRIES regardless of the underlying SO's company.
//
// Behaviour rule: a render error MUST NOT take down the email — the caller
// catches and falls back to buildSimpleTablePdf (ULTIMATE fallback), and
// then to "no attachment", but the notice itself always goes out.
// ---------------------------------------------------------------------------
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// ─── Layout tokens (mirrors PDF in src/lib/pdf-utils.ts so the fallback
//     reads visually like the client renderer) ────────────────────────────
const PAGE_W = 595; // A4 portrait, points
const PAGE_H = 842;
const MARGIN = 36;
const INK = rgb(0.12, 0.11, 0.11);
const MUTED = rgb(0.42, 0.45, 0.48);
const FAINT = rgb(0.6, 0.6, 0.6);
const RULE = rgb(0.82, 0.81, 0.78);
const HEADER_BG = rgb(0.94, 0.94, 0.92);

// Hookka identity (single-source mirror of COMPANY.HOOKKA in
// src/lib/constants.ts — copied here, not imported, so this file stays
// Workers-pure with no React/Vite imports).
const HOOKKA_NAME = "HOOKKA INDUSTRIES SDN BHD";
const HOOKKA_REG = "Reg. 202501060540 (1661946-X)   |   TIN C60515534080";
const HOOKKA_ADDR =
  "2775F, Jalan Industri 12, Kampung Baru Sungai Buloh, 47000 Sungai Buloh, Selangor";
const HOOKKA_CONTACT =
  "Tel +6011-6133 3173   |   hookka.industries@gmail.com";

interface Fonts {
  helv: PDFFont;
  bold: PDFFont;
}

/** Truncate text with an ellipsis to fit within maxWidth at the given font size. */
function clip(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (!text) return "";
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + "...";
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "...";
}

/** Wrap text into N lines that each fit within maxWidth. Hard-truncates the
 *  final line with an ellipsis when the input is longer than maxLines * width. */
function wrap(
  font: PDFFont,
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number,
): string[] {
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    lines[maxLines - 1] = clip(font, lines[maxLines - 1], maxWidth, size);
  }
  return lines;
}

function drawLetterhead(
  page: PDFPage,
  fonts: Fonts,
  docTitle: string,
  docNo: string,
): number {
  // Top company block (left)
  let y = PAGE_H - MARGIN;
  page.drawText(HOOKKA_NAME, {
    x: MARGIN,
    y: y - 10,
    size: 13,
    font: fonts.bold,
    color: INK,
  });
  page.drawText(HOOKKA_REG, {
    x: MARGIN,
    y: y - 22,
    size: 7.5,
    font: fonts.helv,
    color: MUTED,
  });
  page.drawText(clip(fonts.helv, HOOKKA_ADDR, PAGE_W - MARGIN * 2 - 180, 7.5), {
    x: MARGIN,
    y: y - 32,
    size: 7.5,
    font: fonts.helv,
    color: MUTED,
  });
  page.drawText(HOOKKA_CONTACT, {
    x: MARGIN,
    y: y - 42,
    size: 7.5,
    font: fonts.helv,
    color: MUTED,
  });

  // Document title block (right)
  const titleSize = 16;
  const titleW = fonts.bold.widthOfTextAtSize(docTitle, titleSize);
  page.drawText(docTitle, {
    x: PAGE_W - MARGIN - titleW,
    y: y - 12,
    size: titleSize,
    font: fonts.bold,
    color: INK,
  });
  const noW = fonts.helv.widthOfTextAtSize(docNo, 10);
  page.drawText(docNo, {
    x: PAGE_W - MARGIN - noW,
    y: y - 28,
    size: 10,
    font: fonts.helv,
    color: MUTED,
  });

  // Rule under the header band
  y -= 56;
  page.drawRectangle({
    x: MARGIN,
    y,
    width: PAGE_W - MARGIN * 2,
    height: 0.6,
    color: RULE,
  });

  return y - 12;
}

function drawFooter(page: PDFPage, fonts: Fonts): void {
  const footerY = 28;
  page.drawRectangle({
    x: MARGIN,
    y: footerY + 12,
    width: PAGE_W - MARGIN * 2,
    height: 0.4,
    color: RULE,
  });
  const year = new Date().getFullYear();
  const text = `${HOOKKA_NAME} · ${year} · Computer-generated document`;
  page.drawText(text, {
    x: MARGIN,
    y: footerY,
    size: 7,
    font: fonts.helv,
    color: FAINT,
  });
}

/** Two-column meta block — "Bill To / Deliver To" on the left, "Doc info"
 *  on the right. Returns the Y to continue body content from. */
function drawMetaBlock(
  page: PDFPage,
  fonts: Fonts,
  yStart: number,
  left: { label: string; lines: string[] },
  right: Array<{ label: string; value: string }>,
): number {
  const colW = (PAGE_W - MARGIN * 2 - 20) / 2;
  const y = yStart;

  page.drawText(left.label, {
    x: MARGIN,
    y,
    size: 8,
    font: fonts.bold,
    color: MUTED,
  });
  let leftY = y - 12;
  for (const line of left.lines) {
    page.drawText(clip(fonts.helv, line, colW, 9), {
      x: MARGIN,
      y: leftY,
      size: 9,
      font: fonts.helv,
      color: INK,
    });
    leftY -= 11;
  }

  // Right column doc info
  const rightX = MARGIN + colW + 20;
  let rightY = y;
  for (const row of right) {
    page.drawText(row.label, {
      x: rightX,
      y: rightY,
      size: 8,
      font: fonts.bold,
      color: MUTED,
    });
    page.drawText(clip(fonts.helv, row.value || "—", colW - 70, 9), {
      x: rightX + 70,
      y: rightY,
      size: 9,
      font: fonts.helv,
      color: INK,
    });
    rightY -= 12;
  }

  const endY = Math.min(leftY, rightY) - 8;
  page.drawRectangle({
    x: MARGIN,
    y: endY,
    width: PAGE_W - MARGIN * 2,
    height: 0.4,
    color: RULE,
  });
  return endY - 14;
}

interface Col {
  label: string;
  width: number; // points
  align?: "left" | "right";
}

function drawTableHeader(
  page: PDFPage,
  fonts: Fonts,
  y: number,
  cols: Col[],
): number {
  // Gray band
  page.drawRectangle({
    x: MARGIN,
    y: y - 4,
    width: PAGE_W - MARGIN * 2,
    height: 16,
    color: HEADER_BG,
  });
  let x = MARGIN + 4;
  for (const c of cols) {
    const usable = c.width - 6;
    const txt = clip(fonts.bold, c.label, usable, 9);
    const tx =
      c.align === "right"
        ? x + usable - fonts.bold.widthOfTextAtSize(txt, 9)
        : x;
    page.drawText(txt, { x: tx, y: y + 1, size: 9, font: fonts.bold, color: INK });
    x += c.width;
  }
  return y - 20;
}

function drawRow(
  page: PDFPage,
  fonts: Fonts,
  y: number,
  cols: Col[],
  cells: string[],
  bold = false,
): void {
  let x = MARGIN + 4;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    const usable = c.width - 6;
    const font = bold ? fonts.bold : fonts.helv;
    const txt = clip(font, cells[i] ?? "", usable, 8.5);
    const tx =
      c.align === "right"
        ? x + usable - font.widthOfTextAtSize(txt, 8.5)
        : x;
    page.drawText(txt, { x: tx, y, size: 8.5, font, color: INK });
    x += c.width;
  }
}

// ─── DO ────────────────────────────────────────────────────────────────────

export interface BrandedDeliveryOrderOpts {
  doNo: string;
  customerName: string;
  customerAddress: string | null;
  deliverTo: string | null;
  dispatchDate: string | null;
  customerPO: string | null;
  customerSO: string | null;
  driver: string | null;
  contactNo: string | null;
  items: Array<{
    productCode: string;
    productName: string;
    quantity: number;
    rackingNumber: string | null;
  }>;
}

export async function buildBrandedDeliveryOrderPdf(
  opts: BrandedDeliveryOrderOpts,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  let page = doc.addPage([PAGE_W, PAGE_H]);

  let y = drawLetterhead(page, fonts, "DELIVERY ORDER", opts.doNo);
  y = drawMetaBlock(
    page,
    fonts,
    y,
    {
      label: "BILL TO",
      lines: [
        opts.customerName,
        ...wrap(
          fonts.helv,
          opts.customerAddress || "",
          (PAGE_W - MARGIN * 2 - 20) / 2,
          9,
          3,
        ),
        opts.deliverTo ? `Deliver to: ${opts.deliverTo}` : "",
      ].filter(Boolean),
    },
    [
      { label: "DO No.", value: opts.doNo },
      { label: "Date", value: opts.dispatchDate || "" },
      { label: "Customer PO", value: opts.customerPO || "" },
      { label: "Customer SO", value: opts.customerSO || "" },
      { label: "Driver", value: opts.driver || "" },
      { label: "Contact No.", value: opts.contactNo || "" },
    ],
  );

  // Body table — # | Code | Description | Qty | Rack
  const cols: Col[] = [
    { label: "#", width: 24 },
    { label: "Product Code", width: 100 },
    { label: "Description", width: 240 },
    { label: "Qty", width: 38, align: "right" },
    { label: "Rack", width: 120 - 0 }, // remaining
  ];
  // Re-balance to fit the printable area exactly.
  const printable = PAGE_W - MARGIN * 2;
  const consumed = cols.reduce((s, c) => s + c.width, 0);
  cols[cols.length - 1].width += printable - consumed;

  y = drawTableHeader(page, fonts, y, cols);

  const rowH = 14;
  let n = 1;
  for (const it of opts.items) {
    if (y < 70) {
      drawFooter(page, fonts);
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = drawLetterhead(page, fonts, "DELIVERY ORDER", opts.doNo);
      y = drawTableHeader(page, fonts, y, cols);
    }
    drawRow(page, fonts, y, cols, [
      String(n++),
      it.productCode || "-",
      it.productName || "-",
      String(it.quantity ?? 0),
      it.rackingNumber || "-",
    ]);
    y -= rowH;
  }

  drawFooter(page, fonts);
  return await doc.save();
}

// ─── Invoice ───────────────────────────────────────────────────────────────

export interface BrandedInvoiceOpts {
  invoiceNo: string;
  customerName: string;
  customerAddress: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  customerPO: string | null;
  items: Array<{
    productCode: string;
    productName: string;
    quantity: number;
    unitPriceSen: number;
    lineTotalSen: number;
  }>;
  subtotalSen: number;
  taxSen: number;
  totalSen: number;
}

function fmtRm(sen: number): string {
  return ((Number(sen) || 0) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export async function buildBrandedInvoicePdf(
  opts: BrandedInvoiceOpts,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    helv: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  let page = doc.addPage([PAGE_W, PAGE_H]);

  let y = drawLetterhead(page, fonts, "INVOICE", opts.invoiceNo);
  y = drawMetaBlock(
    page,
    fonts,
    y,
    {
      label: "BILL TO",
      lines: [
        opts.customerName,
        ...wrap(
          fonts.helv,
          opts.customerAddress || "",
          (PAGE_W - MARGIN * 2 - 20) / 2,
          9,
          3,
        ),
      ].filter(Boolean),
    },
    [
      { label: "Invoice No.", value: opts.invoiceNo },
      { label: "Invoice Date", value: opts.invoiceDate || "" },
      { label: "Due Date", value: opts.dueDate || "" },
      { label: "Customer PO", value: opts.customerPO || "" },
    ],
  );

  // Body table — # | Code | Description | Qty | Unit Price | Amount
  const cols: Col[] = [
    { label: "#", width: 24 },
    { label: "Product Code", width: 90 },
    { label: "Description", width: 220 },
    { label: "Qty", width: 34, align: "right" },
    { label: "Unit Price (RM)", width: 80, align: "right" },
    { label: "Amount (RM)", width: 75, align: "right" },
  ];
  const printable = PAGE_W - MARGIN * 2;
  const consumed = cols.reduce((s, c) => s + c.width, 0);
  cols[2].width += printable - consumed; // grow description to fill

  y = drawTableHeader(page, fonts, y, cols);

  const rowH = 14;
  let n = 1;
  for (const it of opts.items) {
    if (y < 110) {
      drawFooter(page, fonts);
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = drawLetterhead(page, fonts, "INVOICE", opts.invoiceNo);
      y = drawTableHeader(page, fonts, y, cols);
    }
    drawRow(page, fonts, y, cols, [
      String(n++),
      it.productCode || "-",
      it.productName || "-",
      String(it.quantity ?? 0),
      fmtRm(it.unitPriceSen),
      fmtRm(it.lineTotalSen),
    ]);
    y -= rowH;
  }

  // Totals block
  y -= 4;
  page.drawRectangle({
    x: MARGIN,
    y,
    width: PAGE_W - MARGIN * 2,
    height: 0.6,
    color: RULE,
  });
  y -= 14;
  const labelX = PAGE_W - MARGIN - 180;
  const valueX = PAGE_W - MARGIN - 6;
  const drawTotal = (label: string, value: string, bold = false) => {
    const font = bold ? fonts.bold : fonts.helv;
    page.drawText(label, {
      x: labelX,
      y,
      size: 9,
      font,
      color: INK,
    });
    const valW = font.widthOfTextAtSize(value, 9);
    page.drawText(value, { x: valueX - valW, y, size: 9, font, color: INK });
    y -= 13;
  };
  drawTotal("Subtotal (RM)", fmtRm(opts.subtotalSen));
  if (opts.taxSen > 0) drawTotal("Tax (RM)", fmtRm(opts.taxSen));
  drawTotal("TOTAL (RM)", fmtRm(opts.totalSen), true);

  drawFooter(page, fonts);
  return await doc.save();
}
