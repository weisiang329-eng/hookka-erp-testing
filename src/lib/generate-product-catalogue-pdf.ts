// ---------------------------------------------------------------------------
// generate-product-catalogue-pdf.ts
//
// Photo-rich product lookbook PDF. Customer-facing — clean grid layout,
// model photo or placeholder, category sections, paginated.
//
// Two modes:
//   - Full catalogue  : all models (optionally pre-filtered by category)
//   - Customer filter : only models that have at least one SKU assigned to
//                       the customer (customerId provided)
//
// Photo embedding:
//   Photos are stored via /api/files?resourceType=modular, keyed by
//   resourceId = baseModel. The caller pre-fetches the bytes for each model
//   photo (via fetchModelPhotoBytes) and passes them into ModelEntry.photoBytes.
//   The generator embeds them as PNG/JPEG base64 into the PDF. Any fetch error
//   falls back to a tasteful "no photo" placeholder box.
//
// Grid layout:
//   3 cards per row, portrait A4 (210 × 297 mm), 14mm margins.
//   Photo box: 55mm × 42mm (≈ 4:3). Below: model code, name, category chip,
//   variant count, up to 5 size labels.
// ---------------------------------------------------------------------------
import jsPDF from "jspdf";
import { drawLetterhead, drawSectionLabel, PDF } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CatalogueModelEntry = {
  baseModel: string;
  category: string;
  name: string;
  variantCount: number;
  /** Size labels e.g. ["Single", "Queen", "King"] or ["3+2", "L-Shape"] */
  sizeLabels: string[];
  /** Raw bytes of the first/cover photo, or null if no photo uploaded. */
  photoBytes: Uint8Array | null;
  /** MIME type of the photo ("image/jpeg", "image/png", …). Ignored when photoBytes is null. */
  photoMimeType: string;
};

export type CatalogueOptions = {
  /** Optional ISO date shown in the letterhead. Defaults to today. */
  exportDate?: string;
  /** When provided, header subtitle shows "For: <name>" in the docNo slot. */
  customerName?: string;
  /** Pre-filter to a single category before grouping. "ALL" or undefined = no filter. */
  categoryFilter?: string;
};

// ---------------------------------------------------------------------------
// Layout constants (all in mm)
// ---------------------------------------------------------------------------
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = PDF.margin; // 14mm
const BODY_W = PAGE_W - MARGIN * 2; // 182mm
const COLS = 3;
const COL_GAP = 4; // mm gap between cards
const CARD_W = (BODY_W - COL_GAP * (COLS - 1)) / COLS; // ≈ 58mm
const PHOTO_H = CARD_W * 0.72; // slightly less than 4:3
const TEXT_AREA_H = 27; // mm below photo
const CARD_H = PHOTO_H + TEXT_AREA_H;
const ROW_H = CARD_H + COL_GAP;
const HEADER_H = 42; // space below letterhead (page 1)
const SECTION_H = 10; // section label height
const FOOTER_Y = PAGE_H - 16;
const SAFE_BOTTOM = 22; // clearance above footer for overflow check

// ---------------------------------------------------------------------------
// Category helpers
// ---------------------------------------------------------------------------
const CATEGORY_ORDER = ["BEDFRAME", "SOFA", "ACCESSORY"];

function sortCategories(cats: string[]): string[] {
  const ordered = CATEGORY_ORDER.filter((c) => cats.includes(c));
  const rest = cats.filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...ordered, ...rest];
}

function categoryLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

function categoryChipColor(cat: string): [number, number, number] {
  if (cat === "BEDFRAME") return [55, 110, 65];
  if (cat === "SOFA") return [45, 90, 160];
  if (cat === "ACCESSORY") return [130, 85, 25];
  return [90, 90, 90];
}

// ---------------------------------------------------------------------------
// Bytes → base64 data-URL
// ---------------------------------------------------------------------------
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function imgFmt(mime: string): string {
  if (mime.includes("png")) return "PNG";
  if (mime.includes("gif")) return "GIF";
  return "JPEG";
}

// ---------------------------------------------------------------------------
// Draw a single model card
// ---------------------------------------------------------------------------
function drawCard(doc: jsPDF, entry: CatalogueModelEntry, x: number, y: number): void {
  const r = 1.8;
  const photoY = y;
  const textY = y + PHOTO_H;
  const tx = x + 3;
  const maxTw = CARD_W - 6;

  // Card shadow (very subtle — a slightly larger filled rounded rect in a
  // light grey drawn first, offset 0.8mm down/right).
  doc.setFillColor(230, 228, 224);
  doc.roundedRect(x + 0.8, y + 0.8, CARD_W, CARD_H, r, r, "F");

  // Card background
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, y, CARD_W, CARD_H, r, r, "FD");

  // Photo area background
  doc.setFillColor(248, 247, 245);
  // Fill top half (rounded) + lower half of photo (straight bottom)
  doc.roundedRect(x, photoY, CARD_W, PHOTO_H, r, r, "F");
  // Overwrite bottom half's rounding so it joins flush with the divider
  doc.rect(x, photoY + PHOTO_H - r, CARD_W, r, "F");

  // Photo or placeholder
  if (entry.photoBytes && entry.photoBytes.length > 0) {
    try {
      const fmt = imgFmt(entry.photoMimeType);
      const dataUrl = bytesToDataUrl(entry.photoBytes, entry.photoMimeType);
      doc.addImage(dataUrl, fmt, x, photoY, CARD_W, PHOTO_H, undefined, "FAST");
      // Re-draw card border on top so it shows through any bleed
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.2);
      doc.roundedRect(x, y, CARD_W, CARD_H, r, r, "D");
    } catch {
      drawPlaceholder(doc, x, photoY);
    }
  } else {
    drawPlaceholder(doc, x, photoY);
  }

  // Divider between photo and text
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.15);
  doc.line(x, textY, x + CARD_W, textY);

  // ── Text area ──
  let ty = textY + 4;

  // Model code (bold, primary ink)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF.ink);
  const codeText = (doc.splitTextToSize(entry.baseModel, maxTw) as string[])[0] ?? entry.baseModel;
  doc.text(codeText, tx, ty);
  ty += 3.8;

  // Category chip
  const chipColor = categoryChipColor(entry.category);
  const catLabel = categoryLabel(entry.category);
  doc.setFontSize(5.2);
  doc.setFont("helvetica", "bold");
  const chipW = doc.getTextWidth(catLabel) + 3.5;
  doc.setFillColor(...chipColor);
  doc.roundedRect(tx, ty - 3, chipW, 4.2, 0.8, 0.8, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(catLabel, tx + 1.75, ty);
  ty += 5;

  // Product name (muted)
  doc.setFont("helvetica", "normal");
  doc.setFontSize(5.8);
  doc.setTextColor(...PDF.muted);
  const nameText = (doc.splitTextToSize(entry.name || entry.baseModel, maxTw) as string[])[0] ?? "";
  doc.text(nameText, tx, ty);
  ty += 3.5;

  // Variant count + size labels
  doc.setFontSize(5.2);
  doc.setTextColor(...PDF.faint);
  const varCountStr = `${entry.variantCount} SKU${entry.variantCount === 1 ? "" : "s"}`;
  const sizePart =
    entry.sizeLabels.length > 0
      ? " · " + entry.sizeLabels.slice(0, 5).join(", ") + (entry.sizeLabels.length > 5 ? "…" : "")
      : "";
  const varLine = (doc.splitTextToSize(varCountStr + sizePart, maxTw) as string[])[0] ?? "";
  doc.text(varLine, tx, ty);
}

function drawPlaceholder(doc: jsPDF, x: number, y: number): void {
  const cx = x + CARD_W / 2;
  const cy = y + PHOTO_H / 2;
  // Outer rect
  doc.setDrawColor(190, 183, 172);
  doc.setLineWidth(0.35);
  doc.roundedRect(cx - 9, cy - 7, 18, 14, 1.5, 1.5, "S");
  // Diagonal cross
  doc.setDrawColor(210, 203, 193);
  doc.setLineWidth(0.2);
  doc.line(cx - 9, cy - 7, cx + 9, cy + 7);
  doc.line(cx - 9, cy + 7, cx + 9, cy - 7);
  // Label
  doc.setFont("helvetica", "normal");
  doc.setFontSize(4.8);
  doc.setTextColor(195, 188, 178);
  doc.text("NO PHOTO", cx, cy + 12, { align: "center" });
}

// ---------------------------------------------------------------------------
// Page footer (page number)
// ---------------------------------------------------------------------------
function addPageFooter(doc: jsPDF, pageNum: number, totalPages: number): void {
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.25);
  doc.line(MARGIN, FOOTER_Y, PAGE_W - MARGIN, FOOTER_Y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(...PDF.faint);
  doc.text("HOOKKA INDUSTRIES SDN BHD  ·  Product Catalogue", MARGIN, FOOTER_Y + 4);
  doc.text(`Page ${pageNum} of ${totalPages}`, PAGE_W - MARGIN, FOOTER_Y + 4, { align: "right" });
}

// ---------------------------------------------------------------------------
// Determine total page count (dry-run through the layout)
// ---------------------------------------------------------------------------
function calcTotalPages(allCards: Array<{ firstInCat: boolean }>): number {
  let simY = HEADER_H;
  let simPage = 1;
  let col = 0;

  function wouldOverflow(neededH: number): boolean {
    return simY + neededH > FOOTER_Y - SAFE_BOTTOM;
  }

  for (const { firstInCat } of allCards) {
    if (firstInCat) {
      if (col > 0) { simY += ROW_H; col = 0; }
      if (wouldOverflow(SECTION_H + CARD_H)) { simPage++; simY = MARGIN + 4; }
      simY += SECTION_H;
    } else {
      if (col === 0 && wouldOverflow(CARD_H)) { simPage++; simY = MARGIN + 4; }
    }
    col++;
    if (col === COLS) { simY += ROW_H; col = 0; }
  }
  return simPage;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
export default function generateProductCataloguePdf(
  models: CatalogueModelEntry[],
  opts: CatalogueOptions = {},
): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const today = opts.exportDate ?? new Date().toISOString().slice(0, 10);
  const { customerName, categoryFilter } = opts;

  // Apply category pre-filter
  const filtered =
    categoryFilter && categoryFilter !== "ALL"
      ? models.filter((m) => m.category.toUpperCase() === categoryFilter.toUpperCase())
      : models;

  // Group by category
  const catMap = new Map<string, CatalogueModelEntry[]>();
  for (const m of filtered) {
    const cat = m.category || "OTHER";
    const arr = catMap.get(cat);
    if (arr) arr.push(m);
    else catMap.set(cat, [m]);
  }
  const categories = sortCategories(Array.from(catMap.keys()));

  // Flatten into ordered card list
  type CardItem = { entry: CatalogueModelEntry; cat: string; firstInCat: boolean };
  const allCards: CardItem[] = [];
  for (const cat of categories) {
    (catMap.get(cat) ?? []).forEach((entry, i) =>
      allCards.push({ entry, cat, firstInCat: i === 0 }),
    );
  }

  const totalPages = calcTotalPages(allCards);

  // --- Page 1 letterhead ---
  drawLetterhead(doc, {
    docTitle: "PRODUCT CATALOGUE",
    docNo: customerName ? `For: ${customerName}` : "All Models",
    docDate: today,
  });
  let currentPage = 1;
  addPageFooter(doc, currentPage, totalPages);

  let y = HEADER_H;
  let col = 0;
  let currentCat = "";

  function newPage() {
    doc.addPage();
    currentPage++;
    y = MARGIN + 4;
    col = 0;
    // Thin header bar on continuation pages
    doc.setFillColor(248, 247, 245);
    doc.rect(0, 0, PAGE_W, MARGIN - 1, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.setTextColor(...PDF.accent);
    const contTitle = customerName
      ? `PRODUCT CATALOGUE — ${customerName.toUpperCase()} (cont.)`
      : "PRODUCT CATALOGUE (cont.)";
    doc.text(contTitle, MARGIN, 8.5);
    addPageFooter(doc, currentPage, totalPages);
  }

  function wouldOverflow(neededH: number): boolean {
    return y + neededH > FOOTER_Y - SAFE_BOTTOM;
  }

  for (const { entry, cat, firstInCat } of allCards) {
    // Section header when category changes
    if (firstInCat || cat !== currentCat) {
      if (col > 0) { y += ROW_H; col = 0; }
      if (wouldOverflow(SECTION_H + CARD_H)) newPage();
      y = drawSectionLabel(doc, categoryLabel(cat), y);
      currentCat = cat;
    } else {
      // No section break — check row overflow for a new row start
      if (col === 0 && wouldOverflow(CARD_H)) newPage();
    }

    const cardX = MARGIN + col * (CARD_W + COL_GAP);
    drawCard(doc, entry, cardX, y);
    col++;
    if (col === COLS) { y += ROW_H; col = 0; }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Helper: fetch photo bytes for a model from /api/files/:id/download
// Returns null on any network/parse error (triggers placeholder).
// ---------------------------------------------------------------------------
export async function fetchModelPhotoBytes(
  fileId: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const res = await fetch(`/api/files/${fileId}/download`);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/jpeg";
    const mime = ct.split(";")[0].trim() || "image/jpeg";
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), mimeType: mime };
  } catch {
    return null;
  }
}
