import jsPDF from "jspdf";
import { getQRCodeDataURL, generateStickerData } from "./qr-utils";

// Department colors
const DEPT_COLORS: Record<string, [number, number, number]> = {
  FAB_CUT: [59, 130, 246],
  FAB_SEW: [99, 102, 241],
  WOOD_CUT: [245, 158, 11],
  FOAM: [139, 92, 246],
  FRAMING: [249, 115, 22],
  WEBBING: [16, 185, 129],
  UPHOLSTERY: [244, 63, 94],
  PACKING: [6, 182, 212],
};

const DEPT_NAMES: Record<string, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  WOOD_CUT: "Wood Cutting",
  FOAM: "Foam Bonding",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

type JobCard = {
  id: string;
  departmentCode: string;
  departmentName: string;
  status: string;
  dueDate: string;
  pic1Name: string;
  pic2Name: string;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string;
  productionTimeMinutes: number;
  overdue: string;
  wipCode?: string;
  wipType?: string;
  wipLabel?: string;
  wipQty?: number;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  companySOId: string;
  customerName: string;
  customerState: string;
  customerPOId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  jobCards: JobCard[];
};

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

// DD-MM-YY, used on the portrait Packing sticker so the date stays short
// enough to sit on the same line as a label.
function fmtShortDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${dd}-${mm}-${yy}`;
}

// Sticker sheet sizes. Packing uses the tall 100×150mm FG-style label so
// warehouse staff can see the full-FG model + piece N/total at a glance.
// Everything else keeps the compact 100×60mm landscape dept sticker.
function stickerFormat(deptCode: string): {
  format: [number, number];
  orientation: "landscape" | "portrait";
} {
  if (deptCode === "PACKING") return { format: [100, 150], orientation: "portrait" };
  return { format: [100, 60], orientation: "landscape" };
}

// Piece numbering for one job card within its PO+department. For a Queen
// bedframe PO, Divan jc (wipQty=2) contributes pieces 1-2 of 3, HB jc
// (wipQty=1) contributes piece 3 of 3. Sorting by wipType keeps the order
// stable across prints so Divan always comes before HB.
function piecesForJobCardWithinPo(order: ProductionOrder, jc: JobCard): {
  totalPieces: number;
  startPieceNo: number;
  count: number;
} {
  const sameDept = order.jobCards
    .filter((j) => j.departmentCode === jc.departmentCode)
    .sort((a, b) => {
      const typeA = a.wipType || "";
      const typeB = b.wipType || "";
      if (typeA !== typeB) return typeA.localeCompare(typeB);
      return (a.wipCode || "").localeCompare(b.wipCode || "");
    });
  const totalPieces = sameDept.reduce((s, j) => s + (j.wipQty || 1), 0);
  let startPieceNo = 1;
  for (const j of sameDept) {
    if (j.id === jc.id) break;
    startPieceNo += j.wipQty || 1;
  }
  return { totalPieces, startPieceNo, count: jc.wipQty || 1 };
}

// Piece numbering for sofa FG-level Packing — scoped to the WHOLE SO so
// a customer ordering 2A(LHF) + L(RHF) in one SO gets stickers labelled
// "1/2" and "2/2" across the PO boundary (each assembled sofa = one box,
// the customer just sees a running box count for their delivery). Only
// applies to jc.wipType === "FG" + departmentCode === "PACKING"; every
// other path stays per-PO via piecesForJobCardWithinPo.
function buildSoPackingPieceMap(orders: ProductionOrder[]): Map<
  string,
  { totalPieces: number; startPieceNo: number; count: number }
> {
  type Entry = { order: ProductionOrder; jc: JobCard };
  const bySo = new Map<string, Entry[]>();
  for (const order of orders) {
    if ((order.itemCategory || "").toUpperCase() !== "SOFA") continue;
    for (const jc of order.jobCards) {
      if (jc.departmentCode !== "PACKING") continue;
      if ((jc.wipType || "").toUpperCase() !== "FG") continue;
      const soKey = order.companySOId || order.id;
      if (!bySo.has(soKey)) bySo.set(soKey, []);
      bySo.get(soKey)!.push({ order, jc });
    }
  }
  const result = new Map<
    string,
    { totalPieces: number; startPieceNo: number; count: number }
  >();
  for (const [, entries] of bySo) {
    // Stable sort by poNo so reprints of the same SO always produce the
    // same piece numbering regardless of which PO the worker clicked first.
    entries.sort((a, b) =>
      (a.order.poNo || "").localeCompare(b.order.poNo || ""),
    );
    const totalPieces = entries.reduce((s, e) => s + (e.jc.wipQty || 1), 0);
    let pieceNo = 1;
    for (const e of entries) {
      const count = e.jc.wipQty || 1;
      result.set(`${e.order.id}|${e.jc.id}`, {
        totalPieces,
        startPieceNo: pieceNo,
        count,
      });
      pieceNo += count;
    }
  }
  return result;
}

// Deterministic 6-digit batch code so piece serials stay stable between
// reprints of the same PO — hash the PO id instead of using random/time.
function genBatchCode(order: ProductionOrder): string {
  let h = 0;
  for (let i = 0; i < order.id.length; i++) {
    h = ((h << 5) - h + order.id.charCodeAt(i)) | 0;
  }
  return String(100000 + (Math.abs(h) % 900000));
}

/**
 * Get department-specific fields for a sticker.
 */
function getDeptSpecificFields(
  order: ProductionOrder,
  deptCode: string,
  _jc: JobCard
): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [];

  const findJC = (code: string) => order.jobCards.find((j) => j.departmentCode === code);

  switch (deptCode) {
    case "FAB_CUT":
      fields.push({ label: "Fabric Usage", value: `${order.fabricCode}` });
      fields.push({ label: "Raw Material", value: "Ready" });
      break;

    case "FAB_SEW": {
      const fabCutJC = findJC("FAB_CUT");
      fields.push({
        label: "Fab Cut CD",
        value: fabCutJC?.completedDate ? fmtDate(fabCutJC.completedDate) : "Pending",
      });
      break;
    }

    case "FOAM": {
      const fabSewJC = findJC("FAB_SEW");
      fields.push({
        label: "Fab Sew CD",
        value: fabSewJC?.completedDate ? fmtDate(fabSewJC.completedDate) : "Pending",
      });
      break;
    }

    case "WOOD_CUT": {
      const total =
        (order.gapInches || 0) +
        (order.divanHeightInches || 0) +
        (order.legHeightInches || 0);
      fields.push({ label: "Gap", value: order.gapInches ? `${order.gapInches}"` : "-" });
      fields.push({ label: "Divan", value: order.divanHeightInches ? `${order.divanHeightInches}"` : "-" });
      fields.push({ label: "Leg", value: order.legHeightInches ? `${order.legHeightInches}"` : "-" });
      fields.push({ label: "Total", value: total > 0 ? `${total}"` : "-" });
      break;
    }

    case "FRAMING": {
      const woodCutJC = findJC("WOOD_CUT");
      fields.push({
        label: "Wood Cut CD",
        value: woodCutJC?.completedDate ? fmtDate(woodCutJC.completedDate) : "Pending",
      });
      fields.push({ label: "Gap", value: order.gapInches ? `${order.gapInches}"` : "-" });
      fields.push({ label: "Divan", value: order.divanHeightInches ? `${order.divanHeightInches}"` : "-" });
      fields.push({ label: "Leg", value: order.legHeightInches ? `${order.legHeightInches}"` : "-" });
      break;
    }

    case "WEBBING": {
      const framingJC = findJC("FRAMING");
      fields.push({
        label: "Framing CD",
        value: framingJC?.completedDate ? fmtDate(framingJC.completedDate) : "Pending",
      });
      break;
    }

    case "UPHOLSTERY": {
      if (order.specialOrder) {
        fields.push({ label: "Special Order", value: order.specialOrder.replace(/_/g, " ") });
      }
      const fabSewJC = findJC("FAB_SEW");
      const foamJC = findJC("FOAM");
      const framingJC = findJC("FRAMING");
      fields.push({
        label: "Fab Sew CD",
        value: fabSewJC?.completedDate ? fmtDate(fabSewJC.completedDate) : "Pending",
      });
      fields.push({
        label: "Foam CD",
        value: foamJC?.completedDate ? fmtDate(foamJC.completedDate) : "Pending",
      });
      fields.push({
        label: "Framing CD",
        value: framingJC?.completedDate ? fmtDate(framingJC.completedDate) : "Pending",
      });
      break;
    }

    case "PACKING": {
      if (order.specialOrder) {
        fields.push({ label: "Special Order", value: order.specialOrder.replace(/_/g, " ") });
      }
      const uphJC = findJC("UPHOLSTERY");
      fields.push({
        label: "Upholstery CD",
        value: uphJC?.completedDate ? fmtDate(uphJC.completedDate) : "Pending",
      });
      break;
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Landscape (100×60mm) renderer — Upholstery and all other non-Packing depts.
// Adds parent FG code prominently, WIP label, and piece N/total tag.
// ---------------------------------------------------------------------------
async function renderStickerLandscape(
  doc: jsPDF,
  order: ProductionOrder,
  jc: JobCard,
  pieceNo: number,
  totalPieces: number,
): Promise<void> {
  const color = DEPT_COLORS[jc.departmentCode] || [31, 29, 27];
  const deptName = DEPT_NAMES[jc.departmentCode] || jc.departmentCode;
  const pw = 100;

  // Header strip
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(0, 8, pw, 8);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text(deptName.toUpperCase(), 3, 5.5);
  doc.setFontSize(6);
  doc.text(order.poNo, pw - 3, 5.5, { align: "right" });

  // QR code
  const qrSize = 22;
  const qrX = 3;
  const qrY = 10;
  doc.setDrawColor(200, 200, 200);
  doc.setFillColor(255, 255, 255);
  doc.rect(qrX, qrY, qrSize, qrSize, "FD");

  try {
    const qrDataUrl = await getQRCodeDataURL(
      generateStickerData(
        order.poNo,
        jc.departmentCode,
        jc.id,
        "/production/scan",
        pieceNo,
        totalPieces,
      ),
      200,
    );
    doc.addImage(qrDataUrl, "PNG", qrX + 0.5, qrY + 0.5, qrSize - 1, qrSize - 1);
  } catch {
    doc.setFontSize(5);
    doc.setTextColor(150, 150, 150);
    doc.text("QR CODE", qrX + qrSize / 2, qrY + qrSize / 2, { align: "center" });
    doc.setFontSize(4);
    doc.text(jc.id.slice(0, 12), qrX + qrSize / 2, qrY + qrSize / 2 + 3, { align: "center" });
  }

  // Info block to the right of the QR
  const infoX = qrX + qrSize + 3;
  let y = 13;

  // Parent FG code — big and bold so workers can group stickers by product
  doc.setTextColor(31, 29, 27);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(order.productCode, infoX, y);
  y += 4;

  // WIP label + piece N/total
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  const wipText = jc.wipLabel || jc.wipCode || order.sizeLabel || "";
  const pieceTag = totalPieces > 1 ? `  ${pieceNo}/${totalPieces}` : "";
  doc.text(`${wipText}${pieceTag}`, infoX, y);
  y += 3.5;

  // SO + customer + fabric on a tighter row
  doc.setFontSize(6);
  doc.setTextColor(80, 80, 80);
  doc.text(`SO: ${order.companySOId}`, infoX, y);
  y += 3;
  doc.text(`${order.customerName}`, infoX, y);
  y += 3;
  doc.text(`Colour: ${order.fabricCode}`, infoX, y);
  y += 3;

  // CAT + production time. Hidden when this is a merged FG-level sticker
  // (FAB_CUT per-PO) — the number would aggregate the CATs of multiple
  // components and mislead the cutter into thinking a single CAT rule
  // applies. For upstream per-WIP stickers (Fab Sew / Foam / Wood Cut /
  // Framing / Webbing / Upholstery) the minutes are the worker's time
  // budget for that component, so keep showing them.
  const isFgMerged = (jc.wipType || "").toUpperCase() === "FG";
  if (!isFgMerged) {
    doc.setFontSize(5.5);
    doc.text(`CAT ${jc.category} · ${jc.productionTimeMinutes || jc.estMinutes} min`, infoX, y);
    y += 3;
  }

  // Due date (dept color)
  doc.setTextColor(color[0], color[1], color[2]);
  doc.setFont("helvetica", "bold");
  doc.text(`DD: ${fmtDate(jc.dueDate)}`, infoX, y);

  // Dept-specific fields below QR
  const deptFields = getDeptSpecificFields(order, jc.departmentCode, jc);
  const fy = qrY + qrSize + 3;
  if (deptFields.length > 0) {
    doc.setDrawColor(220, 220, 220);
    doc.line(3, fy - 1, pw - 3, fy - 1);
    doc.setFontSize(5.5);
    const colWidth = (pw - 6) / Math.min(deptFields.length, 4);
    for (let i = 0; i < deptFields.length; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const fx = 3 + col * colWidth;
      const ffy = fy + row * 7;
      doc.setFont("helvetica", "normal");
      doc.setTextColor(130, 130, 130);
      doc.text(deptFields[i].label, fx, ffy);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(31, 29, 27);
      doc.text(deptFields[i].value, fx, ffy + 3);
    }
  }

  // Bottom bar — piece label replaces Qty when we have >1 pieces
  doc.setDrawColor(180, 180, 180);
  doc.line(0, 55, pw, 55);
  doc.setFontSize(4.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text("HOOKKA INDUSTRIES SDN BHD", 3, 58.2);
  const pieceLabel = totalPieces > 1 ? `Piece ${pieceNo}/${totalPieces}` : `Qty: ${order.quantity}`;
  doc.text(pieceLabel, pw - 3, 58.2, { align: "right" });
}

// ---------------------------------------------------------------------------
// Portrait (100×150mm) renderer — Packing only.
// Matches the FG Packing Sticker: big parent model, info grid, large QR
// bottom-left, piece N/total + serial bottom-right.
// ---------------------------------------------------------------------------
async function renderStickerPortrait(
  doc: jsPDF,
  order: ProductionOrder,
  jc: JobCard,
  pieceNo: number,
  totalPieces: number,
  batchCode: string,
): Promise<void> {
  const pw = 100;
  const ph = 150;

  // Outer frame
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.rect(2, 2, pw - 4, ph - 4);

  // Header: parent FG model, centered, big
  doc.setTextColor(31, 29, 27);
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text(order.productCode, pw / 2, 14, { align: "center" });

  // Divider under header
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(5, 20, pw - 5, 20);

  // Info grid
  const labelX = 8;
  const colonX = 28;
  const valueX = 32;
  let iy = 30;
  const rowGap = 8;

  const mfd = jc.completedDate
    ? fmtShortDate(jc.completedDate)
    : jc.dueDate
      ? fmtShortDate(jc.dueDate)
      : "-";

  const infoRows: Array<[string, string]> = [
    ["SIZE", order.sizeLabel || order.sizeCode || "-"],
    ["COLOR", order.fabricCode || "-"],
    ["PO NO", order.companySOId || order.poNo || "-"],
    ["CUST", order.customerName || "-"],
    ["MFD", mfd],
  ];

  doc.setFontSize(9);
  for (const [label, value] of infoRows) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);
    doc.text(label, labelX, iy);
    doc.text(":", colonX, iy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    const wrapped = doc.splitTextToSize(value, pw - valueX - 6);
    doc.text(wrapped[0] || "-", valueX, iy);
    iy += rowGap;
  }

  // QR area (bottom-left, large)
  const qrSize = 42;
  const qrX = 6;
  const qrY = ph - qrSize - 14;
  doc.setDrawColor(200, 200, 200);
  doc.setFillColor(255, 255, 255);
  doc.rect(qrX, qrY, qrSize, qrSize, "FD");
  try {
    const qrDataUrl = await getQRCodeDataURL(
      generateStickerData(
        order.poNo,
        jc.departmentCode,
        jc.id,
        "/production/scan",
        pieceNo,
        totalPieces,
      ),
      300,
    );
    doc.addImage(qrDataUrl, "PNG", qrX + 0.5, qrY + 0.5, qrSize - 1, qrSize - 1);
  } catch {
    doc.setFontSize(6);
    doc.setTextColor(150, 150, 150);
    doc.text("QR CODE", qrX + qrSize / 2, qrY + qrSize / 2, { align: "center" });
  }

  // Right column: piece ratio + WIP label + serial
  const rightX = qrX + qrSize + 5;
  let ry = qrY + 8;

  doc.setTextColor(31, 29, 27);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text(`${pieceNo}/${totalPieces}`, rightX, ry);
  ry += 7;

  // Label under the piece ratio. For bedframe multi-piece Packing (one card
  // per Divan/HB), the WIP label distinguishes them. For sofa FG Packing
  // (assembled whole sofa), the WIP label would just be the productCode
  // again — redundant with the big header — so show the sizeLabel instead
  // (e.g. "2A(LHF)") which is the cross-SO identifier the user is tracking.
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 100, 100);
  const isFgLevel = (jc.wipType || "").toUpperCase() === "FG";
  const wipText = isFgLevel
    ? order.sizeLabel || order.sizeCode || order.productCode || ""
    : jc.wipLabel || jc.wipCode || "WIP";
  const wipLines = doc.splitTextToSize(wipText, pw - rightX - 6);
  doc.text(wipLines, rightX, ry);
  ry += 3.6 * Math.min(wipLines.length, 3) + 3;

  // Serial (batchCode + pieceNo)
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(`${batchCode}-${pieceNo}`, rightX, ry);
  ry += 5;

  // Piece tag (small, grey)
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text(`Piece ${pieceNo}/${totalPieces}`, rightX, ry);

  // Bottom branding
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.2);
  doc.line(5, ph - 8, pw - 5, ph - 8);
  doc.setFontSize(5.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text("HOOKKA INDUSTRIES SDN BHD", pw / 2, ph - 4, { align: "center" });
}

async function renderSticker(
  doc: jsPDF,
  order: ProductionOrder,
  jc: JobCard,
  pieceNo: number,
  totalPieces: number,
  batchCode: string,
): Promise<void> {
  if (jc.departmentCode === "PACKING") {
    await renderStickerPortrait(doc, order, jc, pieceNo, totalPieces, batchCode);
  } else {
    await renderStickerLandscape(doc, order, jc, pieceNo, totalPieces);
  }
}

// Synthesise a "merged" job card that represents every FAB_CUT card on
// one PO cut in a single pass. Uses the first card as the template so
// fields the renderer doesn't tweak (departmentCode, status, dueDate…)
// still make sense, then overrides wipType to the FG sentinel so the
// landscape renderer hides the per-WIP CAT/min line (would be meaningless
// on a merged row) and prints a joined WIP label + summed minutes
// instead. id is suffixed with ":FG-FAB_CUT" — any downstream code
// reading that id should treat it as "all FAB_CUT jcs for this PO".
function buildMergedFabCutJc(jcs: JobCard[]): JobCard {
  const sorted = [...jcs].sort(
    (a, b) => (a.wipType || "").localeCompare(b.wipType || ""),
  );
  const first = sorted[0];
  const joinedLabel = sorted
    .map((j) => j.wipLabel || j.wipCode || "")
    .filter(Boolean)
    .join("  |  ");
  const totalMinutes = sorted.reduce(
    (s, j) => s + (j.productionTimeMinutes || j.estMinutes || 0),
    0,
  );
  // opId sentinel: the scan page keys off the "FG-" prefix to decide
  // between the per-jc scan-complete endpoint and the fan-out
  // scan-complete-dept endpoint. Keep this constant per dept so every
  // FAB_CUT merged sticker produces the same sentinel — the PO id
  // lives in the QR's `po` query param and is what the scanner uses to
  // locate the matching job cards.
  return {
    ...first,
    id: "FG-FAB_CUT",
    wipType: "FG",
    wipCode: first.wipCode,
    wipLabel: joinedLabel || first.wipLabel,
    wipQty: sorted.reduce((s, j) => s + (j.wipQty || 1), 0),
    productionTimeMinutes: totalMinutes,
    estMinutes: totalMinutes,
  };
}

// Resolve a job card's piece range, preferring SO-level aggregation for
// sofa FG-level Packing when the SO map contains it — otherwise falls
// back to per-PO counting.
function resolvePieces(
  order: ProductionOrder,
  jc: JobCard,
  soMap: Map<string, { totalPieces: number; startPieceNo: number; count: number }>,
): { totalPieces: number; startPieceNo: number; count: number } {
  const key = `${order.id}|${jc.id}`;
  const soScoped = soMap.get(key);
  if (soScoped) return soScoped;
  return piecesForJobCardWithinPo(order, jc);
}

/**
 * Generate a sticker PDF for one specific job card. `siblingOrders` lets the
 * caller pass the other POs under the same SO so sofa FG Packing piece
 * numbering spans the whole SO ("1/2", "2/2" across POs) rather than
 * collapsing to "1/1" per PO. Single-print from the dept page should pass
 * the full visible order list for correct cross-PO numbering.
 */
export async function generateStickerPdf(
  order: ProductionOrder,
  jc: JobCard,
  siblingOrders: ProductionOrder[] = [order],
): Promise<void> {
  const { format, orientation } = stickerFormat(jc.departmentCode);
  const doc = new jsPDF({ orientation, unit: "mm", format });
  const soMap = buildSoPackingPieceMap(siblingOrders);
  const { totalPieces, startPieceNo, count } = resolvePieces(order, jc, soMap);
  const batchCode = genBatchCode(order);

  for (let i = 0; i < count; i++) {
    if (i > 0) doc.addPage(format, orientation);
    const pieceNo = startPieceNo + i;
    await renderSticker(doc, order, jc, pieceNo, totalPieces, batchCode);
  }

  doc.save(`sticker-${order.poNo}-${jc.departmentCode}-${jc.wipType || "WIP"}.pdf`);
}

/**
 * Batch sticker PDF across many orders for one department. Emits one page
 * per physical piece — a Queen bedframe PO (Divan wipQty=2 + HB wipQty=1)
 * contributes 3 pages, and a sofa SO with two POs (2A + L) produces 2
 * Packing pages numbered across the whole SO, not per-PO.
 */
export async function generateBatchStickersPdf(
  orders: ProductionOrder[],
  deptCode: string,
): Promise<{ generated: number; skipped: number }> {
  const { format, orientation } = stickerFormat(deptCode);
  const doc = new jsPDF({ orientation, unit: "mm", format });
  const soMap = buildSoPackingPieceMap(orders);

  let generated = 0;
  let skipped = 0;
  for (const order of orders) {
    const matchingJcs = order.jobCards.filter((j) => j.departmentCode === deptCode);
    if (matchingJcs.length === 0) {
      skipped++;
      continue;
    }
    const batchCode = genBatchCode(order);

    // FAB_CUT merge: one FG-level sticker per PO regardless of how many
    // WIPs are being cut. Matches the production-sheet row merge — the
    // cutter lays down one bolt per PO and the QR it scans completes
    // every FAB_CUT job card for that PO in one step. Build a synthetic
    // "merged" job card that carries the summed minutes and joined WIP
    // labels so the sticker renderer has the info it needs.
    if (deptCode === "FAB_CUT") {
      if (generated > 0) doc.addPage(format, orientation);
      const mergedJc: JobCard = buildMergedFabCutJc(matchingJcs);
      await renderSticker(doc, order, mergedJc, 1, 1, batchCode);
      generated++;
      continue;
    }

    for (const jc of matchingJcs) {
      const { totalPieces, startPieceNo, count } = resolvePieces(order, jc, soMap);
      for (let i = 0; i < count; i++) {
        if (generated > 0) doc.addPage(format, orientation);
        const pieceNo = startPieceNo + i;
        await renderSticker(doc, order, jc, pieceNo, totalPieces, batchCode);
        generated++;
      }
    }
  }

  if (generated === 0) {
    return { generated, skipped };
  }

  doc.save(`stickers-${deptCode}-batch.pdf`);
  return { generated, skipped };
}
