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

/**
 * Render one sticker page into the PDF at the current page.
 * Sticker dimensions: ~100 x 60mm
 */
async function renderSticker(
  doc: jsPDF,
  order: ProductionOrder,
  deptCode: string
): Promise<void> {
  const jc = order.jobCards.find((j) => j.departmentCode === deptCode);
  if (!jc) return;

  const color = DEPT_COLORS[deptCode] || [31, 29, 27];
  const deptName = DEPT_NAMES[deptCode] || deptCode;

  // Page is 100x60mm. Origin at top-left.
  const pw = 100;

  // --- Department header ---
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(0, 8, pw, 8);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text(deptName.toUpperCase(), 3, 5.5);
  doc.setFontSize(6);
  doc.text(order.poNo, pw - 3, 5.5, { align: "right" });

  // --- QR Code placeholder area (top-left, below header) ---
  const qrSize = 22;
  const qrX = 3;
  const qrY = 10;

  // Draw QR placeholder box
  doc.setDrawColor(200, 200, 200);
  doc.setFillColor(255, 255, 255);
  doc.rect(qrX, qrY, qrSize, qrSize, "FD");

  // Generate QR locally — avoids hundreds of external qrserver.com round-trips
  // during batch prints. Falls back to a text placeholder if generation fails.
  try {
    const qrDataUrl = await getQRCodeDataURL(
      generateStickerData(order.poNo, deptCode, jc.id),
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

  // --- Product info to the right of QR ---
  const infoX = qrX + qrSize + 3;
  let y = 12;

  doc.setTextColor(31, 29, 27);
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.text(`SO: ${order.companySOId}`, infoX, y);
  y += 3.5;

  doc.setFontSize(6);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(order.customerName, infoX, y);
  y += 3.5;

  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(`${order.productCode} - ${order.sizeLabel}`, infoX, y);
  y += 3.5;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Colour: ${order.fabricCode}`, infoX, y);
  y += 3.5;

  // CAT + Production Time
  doc.setFontSize(5.5);
  doc.text(`CAT: ${jc.category}  |  ${jc.productionTimeMinutes || jc.estMinutes} min`, infoX, y);
  y += 3;

  // Due date
  doc.setTextColor(color[0], color[1], color[2]);
  doc.setFont("helvetica", "bold");
  doc.text(`DD: ${fmtDate(jc.dueDate)}`, infoX, y);

  // --- Department-specific fields below QR ---
  const deptFields = getDeptSpecificFields(order, deptCode, jc);
  const fy = qrY + qrSize + 3;

  if (deptFields.length > 0) {
    // Separator line
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

  // --- Bottom bar ---
  doc.setDrawColor(180, 180, 180);
  doc.line(0, 55, pw, 55);
  doc.setFontSize(4.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120, 120, 120);
  doc.text("HOOKKA INDUSTRIES SDN BHD", 3, 58.2);
  doc.text(`Qty: ${order.quantity}`, pw - 3, 58.2, { align: "right" });
}

/**
 * Generate a single sticker PDF for one production order + department.
 */
export async function generateStickerPdf(
  order: ProductionOrder,
  deptCode: string
): Promise<void> {
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: [100, 60],
  });

  await renderSticker(doc, order, deptCode);
  doc.save(`sticker-${order.poNo}-${deptCode}.pdf`);
}

/**
 * Generate batch sticker PDF - one sticker per page for all orders.
 */
export async function generateBatchStickersPdf(
  orders: ProductionOrder[],
  deptCode: string
): Promise<{ generated: number; skipped: number }> {
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: [100, 60],
  });

  let generated = 0;
  let skipped = 0;
  for (const order of orders) {
    const jc = order.jobCards.find((j) => j.departmentCode === deptCode);
    if (!jc) {
      skipped++;
      continue;
    }

    if (generated > 0) {
      doc.addPage([100, 60], "landscape");
    }
    generated++;

    await renderSticker(doc, order, deptCode);
  }

  if (generated === 0) {
    return { generated, skipped };
  }

  doc.save(`stickers-${deptCode}-batch.pdf`);
  return { generated, skipped };
}
