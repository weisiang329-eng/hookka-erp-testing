// ---------------------------------------------------------------------------
// Unified Delivery Order + Invoice PDF (pdf-lib) — ONE generator used by BOTH
// the browser "Download PDF" and the backend customer-notify auto-email, so the
// customer always receives EXACTLY what the operator sees. Replaces the split
// jsPDF (browser-only src/lib/generate-do-pdf.ts / generate-invoice-pdf.ts) +
// the simplified backend fallback (branded-fallback-pdf.ts). pdf-lib runs on
// both Cloudflare Workers and the browser, so a single file is the source of
// truth — a future template edit is a one-file change (owner 2026-07-02).
//
// Layout is a faithful copy of the current jsPDF documents:
//   ┌ HOOKKA logo + company block            DELIVERY ORDER / INVOICE ─┐
//   │ Reg / TIN / address / contact          No. …   ·  date  ·  terms │
//   ├ Customer / Deliver To / Address / Contact   DO No / Date / Driver ┤
//   ├ [category band] BEDFRAME / SOFA …                                 │
//   │ Order(4 refs) | Description(code+name+spec) | Set | Qty | Total   │
//   ├ Total   N SETS   …   M ITEMS   (grand piece breakdown)            │
//   └ signatures / footer                                               ┘
// ---------------------------------------------------------------------------
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const INK = rgb(0.1, 0.09, 0.09);
const MUTED = rgb(0.42, 0.45, 0.48);
const FAINT = rgb(0.62, 0.62, 0.6);
const RULE = rgb(0.82, 0.81, 0.78);
const BAND = rgb(0.92, 0.92, 0.9);

const HOOKKA_NAME = "HOOKKA INDUSTRIES SDN BHD";
const HOOKKA_REG = "Reg. 202501060540 (1661946-X)   |   TIN C60515534080";
const HOOKKA_ADDR =
  "2775F, Jalan Industri 12, Kampung Baru Sungai Buloh, 47000 Sungai Buloh, Selangor";
const HOOKKA_CONTACT = "Tel +6011-6133 3173   |   hookka.industries@gmail.com";

export interface UnifiedLineItem {
  // Left "Order" cell — up to 4 reference lines, e.g.
  //   ["Our SO: SO-2606-065", "PO: PO-009093", "SO: HC9362", "REF: HC9362"]
  orderRefs: string[];
  // "Description" cell — code + name + spec lines, joined below the code.
  code: string;
  name: string;
  specLines: string[];
  set: number;
  // DO: quantity breakdown text ("1 HB  +  2 Divan") + total pieces.
  qtyBreakdown?: string;
  totalQty?: number;
  // Invoice: price + line total (already sen).
  priceSen?: number;
  lineTotalSen?: number;
  // Invoice: itemised Price-column build-up (Base + Divan + … + "=" unit).
  // Absent → the Price column shows the single price.
  priceBreakdown?: Array<{ label: string; sen: number }>;
}

export interface UnifiedDocGroup {
  category: string; // band label — "BEDFRAME", "SOFA", …
  items: UnifiedLineItem[];
}

export interface UnifiedDocData {
  kind: "DO" | "INVOICE";
  docNo: string;
  docDate: string;
  statusText: string; // "C.O.D." | "NET 30"
  // Left reference block (label → value); order preserved.
  leftFields: Array<[string, string]>;
  rightFields: Array<[string, string]>;
  groups: UnifiedDocGroup[];
  // Footer aggregates.
  totalSets: number;
  totalItems?: number; // DO
  grandBreakdown?: string; // DO — "9 HB  +  18 Divan"
  subtotalSen?: number; // INVOICE
  taxSen?: number; // INVOICE
  totalSen?: number; // INVOICE
  amountInWords?: string; // INVOICE
  // Base64 PNG (no data-URI prefix) of the HOOKKA logo. Optional — omitted →
  // text-only letterhead. Backend passes HOOKKA_LOGO_PNG_BASE64; FE its inline.
  logoPngBase64?: string;
}

const LOGO_ASPECT = 2038 / 907;

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:image\/png;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function money(sen: number): string {
  return ((Number(sen) || 0) / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// pdf-lib StandardFonts (Helvetica) can only encode WinAnsi (Latin-1) glyphs.
// A SINGLE non-Latin character anywhere in the data — a Chinese char, an
// em-dash, smart quotes, a bullet — makes widthOfTextAtSize / drawText THROW,
// which crashed the entire render and dropped the customer to the ugly
// simple-table fallback (owner 2026-07-13: "之前發的時候都沒用" — the nice
// version rarely reached the customer). Sanitise EVERY drawn string: map the
// common typography to ASCII, collapse odd spaces, and replace anything still
// outside Latin-1 with "?" so no stray glyph can ever crash the document.
// Exported so the simple-table fallback (assistant-exports.ts) shares the
// exact same guard — the last-resort render must be crash-proof too.
export function winAnsi(s: string): string {
  if (!s) return s;
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2022\u00B7]/g, "-")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/[^\x20-\x7E\u00A1-\u00FF\n]/g, "?");
}

// Wrap text to fit maxW, matching how the original jsPDF-autotable documents
// handle overflow (`overflow: "linebreak"`): word-wrap, and break any single
// token that is itself wider than the column by character. The row grows to fit
// the wrapped lines — nothing is ever truncated or pushed under the next column
// (owner 2026-07-02: "照我們的怎麼處理就怎麼處理" — wrap, don't ellipsis).
function wrapHard(font: PDFFont, rawText: string, maxW: number, size: number, maxLines = 12): string[] {
  const text = winAnsi(rawText);
  if (!text) return [];
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxW;
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (let w of text.split(/\s+/).filter(Boolean)) {
    // A single token wider than the column: break it by character.
    while (!fits(w) && out.length < maxLines) {
      flush();
      let i = 1;
      while (i < w.length && fits(w.slice(0, i + 1))) i++;
      out.push(w.slice(0, i));
      w = w.slice(i);
    }
    if (out.length >= maxLines) break;
    const cand = cur ? `${cur} ${w}` : w;
    if (fits(cand)) cur = cand;
    else { flush(); cur = w; }
    if (out.length >= maxLines) break;
  }
  flush();
  return out.slice(0, maxLines);
}

function wrap(font: PDFFont, rawText: string, maxW: number, size: number, maxLines = 4): string[] {
  const text = winAnsi(rawText);
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(cand, size) <= maxW) cur = cand;
    else {
      if (cur) out.push(cur);
      cur = w;
      if (out.length >= maxLines) break;
    }
  }
  if (cur && out.length < maxLines) out.push(cur);
  return out;
}

interface Fonts { helv: PDFFont; bold: PDFFont }

function rightText(page: PDFPage, text: string, xRight: number, y: number, size: number, font: PDFFont, color = INK) {
  const t = winAnsi(text);
  const w = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: xRight - w, y, size, font, color });
}

export async function buildUnifiedDocPdf(data: UnifiedDocData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    helv: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  let page = pdf.addPage([PAGE_W, PAGE_H]);

  const logo = data.logoPngBase64
    ? await pdf.embedPng(b64ToBytes(data.logoPngBase64)).catch(() => null)
    : null;
  const logoH = 34;
  const logoW = logoH * LOGO_ASPECT;
  const textX = logo ? MARGIN + logoW + 8 : MARGIN;

  const title = data.kind === "DO" ? "DELIVERY ORDER" : "INVOICE";

  // ── Letterhead ──────────────────────────────────────────────────────────
  const drawLetterhead = (): number => {
    let y = PAGE_H - MARGIN;
    if (logo) page.drawImage(logo, { x: MARGIN, y: y - 46, width: logoW, height: logoH });
    page.drawText(HOOKKA_NAME, { x: textX, y: y - 10, size: 13, font: fonts.bold, color: INK });
    page.drawText(HOOKKA_REG, { x: textX, y: y - 22, size: 7.5, font: fonts.helv, color: MUTED });
    page.drawText(HOOKKA_ADDR, { x: textX, y: y - 32, size: 7.5, font: fonts.helv, color: MUTED });
    page.drawText(HOOKKA_CONTACT, { x: textX, y: y - 42, size: 7.5, font: fonts.helv, color: MUTED });
    rightText(page, title, PAGE_W - MARGIN, y - 13, 17, fonts.bold);
    rightText(page, `No. ${data.docNo}`, PAGE_W - MARGIN, y - 30, 11, fonts.bold);
    rightText(page, `${data.docDate}   |   ${data.statusText}`, PAGE_W - MARGIN, y - 42, 8.5, fonts.helv, MUTED);
    y -= 54;
    page.drawRectangle({ x: MARGIN, y, width: PAGE_W - MARGIN * 2, height: 0.7, color: INK });
    return y - 14;
  };

  let y = drawLetterhead();

  // ── Reference block (two columns) ───────────────────────────────────────
  const labelW = 60;
  const colGap = PAGE_W / 2 + 12;
  const drawField = (x: number, yy: number, k: string, v: string, maxW: number): number => {
    page.drawText(winAnsi(k), { x, y: yy, size: 8, font: fonts.helv, color: MUTED });
    const lines = wrap(fonts.bold, v || "-", maxW - labelW, 8.5, 3);
    (lines.length ? lines : ["-"]).forEach((ln, i) => {
      page.drawText(ln, { x: x + labelW, y: yy - i * 10, size: 8.5, font: fonts.bold, color: INK });
    });
    return yy - Math.max(1, lines.length) * 10 - 1.5;
  };
  let ly = y;
  let ry = y;
  const leftMaxW = colGap - MARGIN - 12;
  const rightMaxW = PAGE_W - MARGIN - colGap;
  for (const [k, v] of data.leftFields) ly = drawField(MARGIN, ly, k, v, leftMaxW);
  for (const [k, v] of data.rightFields) ry = drawField(colGap, ry, k, v, rightMaxW);
  y = Math.min(ly, ry) - 8;

  // ── Items table ─────────────────────────────────────────────────────────
  const isDO = data.kind === "DO";
  const xOrder = MARGIN;
  const wOrder = 108;
  const xDesc = xOrder + wOrder + 6;
  const wDesc = isDO ? 232 : 232;
  const xSet = xDesc + wDesc + 6;
  const xCol4Right = isDO ? PAGE_W - MARGIN - 66 : PAGE_W - MARGIN - 78;
  const xCol5Right = PAGE_W - MARGIN;

  const drawTableHeader = (yy: number): number => {
    page.drawText("Order", { x: xOrder, y: yy, size: 8, font: fonts.bold, color: MUTED });
    page.drawText("Description", { x: xDesc, y: yy, size: 8, font: fonts.bold, color: MUTED });
    page.drawText("Set", { x: xSet, y: yy, size: 8, font: fonts.bold, color: MUTED });
    rightText(page, isDO ? "Quantity" : "Price (RM)", xCol4Right, yy, 8, fonts.bold, MUTED);
    rightText(page, isDO ? "Total Qty" : "Total Price (RM)", xCol5Right, yy, 8, fonts.bold, MUTED);
    const ry2 = yy - 5;
    page.drawRectangle({ x: MARGIN, y: ry2, width: PAGE_W - MARGIN * 2, height: 0.6, color: RULE });
    return ry2 - 12;
  };

  const ensureSpace = (need: number, withHeader = true) => {
    if (y - need < 60) {
      drawFooterLine();
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = drawLetterhead();
      if (withHeader) y = drawTableHeader(y);
    }
  };

  const drawFooterLine = () => {
    page.drawRectangle({ x: MARGIN, y: 40, width: PAGE_W - MARGIN * 2, height: 0.4, color: RULE });
    page.drawText(`${HOOKKA_NAME} · Computer-generated ${isDO ? "delivery order" : "invoice"}`, {
      x: MARGIN, y: 31, size: 7, font: fonts.helv, color: FAINT,
    });
  };

  y = drawTableHeader(y);

  for (const g of data.groups) {
    ensureSpace(16);
    page.drawRectangle({ x: MARGIN, y: y - 3, width: PAGE_W - MARGIN * 2, height: 12, color: BAND });
    page.drawText(winAnsi(g.category), { x: xOrder + 2, y: y, size: 8, font: fonts.bold, color: INK });
    y -= 16;

    for (const it of g.items) {
      // Every column wraps within its width (row grows to fit the tallest) —
      // exactly how the autotable original handles long data. The Quantity
      // column is the gap between the Set number and its right edge.
      const qtyColW = xCol4Right - (xSet + 18);
      const refWrapped: string[] = [];
      for (const r of it.orderRefs.slice(0, 4)) refWrapped.push(...wrapHard(fonts.helv, r, wOrder - 2, 7.5, 3));
      const codeWrapped = wrapHard(fonts.bold, it.code, wDesc, 8, 2);
      const nameWrapped = wrapHard(fonts.helv, it.name, wDesc, 7.5, 3);
      const specWrapped: string[] = [];
      for (const s of it.specLines) specWrapped.push(...wrapHard(fonts.helv, s, wDesc, 7.5, 3));
      const qtyWrapped = isDO ? wrapHard(fonts.helv, it.qtyBreakdown || "-", qtyColW, 7.5, 4) : [];
      const descLineCount = codeWrapped.length + nameWrapped.length + specWrapped.length;
      const priceBreakdownLines = !isDO && it.priceBreakdown ? it.priceBreakdown.length : 0;
      const rowLines = Math.max(refWrapped.length, descLineCount, qtyWrapped.length, priceBreakdownLines, 1);
      const rowH = rowLines * 9.3 + 6;
      ensureSpace(rowH);

      refWrapped.forEach((r, i) => {
        page.drawText(r, { x: xOrder, y: y - i * 9.3, size: 7.5, font: fonts.helv, color: INK });
      });
      // Description: code (bold) then name then spec, each wrapped to the column.
      let dl = 0;
      for (const ln of codeWrapped) { page.drawText(ln, { x: xDesc, y: y - dl * 9.3, size: 8, font: fonts.bold, color: INK }); dl++; }
      for (const ln of nameWrapped) { page.drawText(ln, { x: xDesc, y: y - dl * 9.3, size: 7.5, font: fonts.helv, color: INK }); dl++; }
      for (const ln of specWrapped) { page.drawText(ln, { x: xDesc, y: y - dl * 9.3, size: 7.5, font: fonts.helv, color: MUTED }); dl++; }

      // Set / Price / Total are single-line values. Centre them against the
      // DESCRIPTION block (code + name + spec) — the product identity — NOT the
      // whole row. The Order column is often 4 lines (PO/SO/REF/CO) that are
      // mostly "-", which padded the row tall and sank the numbers into the
      // empty middle, reading as misaligned against each product (owner
      // 2026-07-13: "數字跟產品編號沒對齊"). Centring on the description keeps
      // every number beside the item it prices. DO stays top-aligned (fine).
      const midY = y - ((Math.max(1, descLineCount) - 1) * 9.3) / 2;
      if (isDO) {
        page.drawText(String(it.set), { x: xSet, y, size: 8, font: fonts.helv, color: INK });
        // Pieces breakdown wraps within the Quantity column (a multi-component
        // repair line stacks over several lines instead of spilling across).
        (qtyWrapped.length ? qtyWrapped : ["-"]).forEach((ln, i) => {
          rightText(page, ln, xCol4Right, y - i * 9.3, 7.5, fonts.helv, INK);
        });
        rightText(page, String(it.totalQty ?? ""), xCol5Right, y, 8, fonts.helv, INK);
      } else if (it.priceBreakdown && it.priceBreakdown.length) {
        // Itemised Price column (restored from the pre-unified jsPDF invoice):
        // Base / + surcharge / = unit, stacked from the row top. The line-total
        // aligns to the "=" (unit) row so the two right-hand numbers read as a
        // pair. Surcharge rows are muted; the "=" and total are bold.
        page.drawText(String(it.set), { x: xSet, y: midY, size: 8, font: fonts.helv, color: INK });
        it.priceBreakdown.forEach((r, i) => {
          const isTotal = r.label === "=";
          rightText(
            page,
            `${r.label} ${money(r.sen)}`,
            xCol4Right,
            y - i * 9.3,
            7,
            isTotal ? fonts.bold : fonts.helv,
            isTotal ? INK : MUTED,
          );
        });
        const lastY = y - (it.priceBreakdown.length - 1) * 9.3;
        rightText(page, money(it.lineTotalSen ?? 0), xCol5Right, lastY, 8, fonts.bold, INK);
      } else {
        page.drawText(String(it.set), { x: xSet, y: midY, size: 8, font: fonts.helv, color: INK });
        rightText(page, money(it.priceSen ?? 0), xCol4Right, midY, 8, fonts.helv, INK);
        rightText(page, money(it.lineTotalSen ?? 0), xCol5Right, midY, 8, fonts.bold, INK);
      }
      y -= rowH;
      // Dashed row separator — sit it in the MIDDLE of the inter-row gap. rowH
      // carries one full line-height + 6pt of padding beyond the last content
      // line, so the clear gap below `y` (the next row's top baseline) is a
      // constant ~15pt. At y+3 the dashes fell only 3pt above the next row's
      // baseline, cutting through its code + numbers (owner 2026-07-13: "線也
      //歪了"). y+10 centres them so they clear both rows' text.
      for (let dx = MARGIN; dx < PAGE_W - MARGIN; dx += 4) {
        page.drawRectangle({ x: dx, y: y + 10, width: 2, height: 0.3, color: RULE });
      }
    }
  }

  // ── Totals row ──────────────────────────────────────────────────────────
  // The DO grand breakdown gets its OWN full-width wrapping row (like the
  // original's colSpan-5 footer row) so a many-component total wraps across the
  // page instead of being squeezed off the Quantity cell (owner "被擠出去" fix).
  const gbLines =
    isDO && data.grandBreakdown
      ? wrapHard(fonts.helv, data.grandBreakdown, PAGE_W - MARGIN * 2, 8, 4)
      : [];
  // Reserve the WHOLE tail (totals + breakdown / invoice summary + signature
  // block) so it never crosses the footer — else push it to a fresh page.
  ensureSpace((isDO ? 70 + gbLines.length * 11 : 138), false);
  page.drawRectangle({ x: MARGIN, y: y + 2, width: PAGE_W - MARGIN * 2, height: 0.7, color: INK });
  y -= 6;
  rightText(page, "Total", xSet - 6, y, 8.5, fonts.bold);
  page.drawText(`${data.totalSets} SETS`, { x: xSet, y, size: 8.5, font: fonts.bold, color: INK });
  if (isDO) {
    rightText(page, `${data.totalItems ?? 0} ITEMS`, xCol5Right, y, 8.5, fonts.bold);
    for (const ln of gbLines) {
      y -= 11;
      rightText(page, ln, xCol5Right, y, 8, fonts.helv, MUTED);
    }
  } else {
    rightText(page, "Subtotal", xCol4Right, y, 8.5, fonts.bold);
    rightText(page, money(data.subtotalSen ?? 0), xCol5Right, y, 8.5, fonts.bold);
  }

  // ── Invoice financial summary + words ───────────────────────────────────
  if (!isDO) {
    y -= 22;
    const lblX = PAGE_W - MARGIN - 120;
    const sum = (k: string, v: string, bold = false, big = false) => {
      rightText(page, k, lblX, y, big ? 10 : 8.5, bold ? fonts.bold : fonts.helv, bold ? INK : MUTED);
      rightText(page, v, PAGE_W - MARGIN, y, big ? 11 : 8.5, fonts.bold, INK);
      y -= big ? 14 : 11;
    };
    sum("Subtotal", `RM ${money(data.subtotalSen ?? 0)}`);
    if (data.taxSen) sum("Tax", `RM ${money(data.taxSen)}`);
    sum("Total", `RM ${money(data.totalSen ?? 0)}`, true, true);
    if (data.amountInWords) {
      page.drawText(winAnsi(data.amountInWords), { x: MARGIN, y: y + 2, size: 8, font: fonts.helv, color: MUTED });
    }
  }

  // ── Signatures ──────────────────────────────────────────────────────────
  y -= 30;
  const halfW = (PAGE_W - MARGIN * 2 - 24) / 2;
  if (isDO) {
    page.drawRectangle({ x: MARGIN, y, width: halfW, height: 0.6, color: INK });
    page.drawRectangle({ x: PAGE_W - MARGIN - halfW, y, width: halfW, height: 0.6, color: INK });
    page.drawText("Prepared By", { x: MARGIN, y: y - 10, size: 8, font: fonts.helv, color: MUTED });
    rightText(page, "Received in Good Order", PAGE_W - MARGIN, y - 10, 8, fonts.helv, MUTED);
  } else {
    page.drawRectangle({ x: PAGE_W - MARGIN - halfW, y, width: halfW, height: 0.6, color: INK });
    rightText(page, "Customer Stamp & Signature", PAGE_W - MARGIN, y - 10, 8, fonts.helv, MUTED);
  }

  drawFooterLine();
  return pdf.save();
}
