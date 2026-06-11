import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtDate, addHookkaLetterhead } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Consignment Note PDF — the CN twin of generate-do-pdf.ts (owner asked for
// full CN/DO document parity, 2026-06-11). Same A4-portrait greyscale family:
// Hookka letterhead, reference block (deliver-to / state / dispatch info /
// 3PL driver + lorry), items table, totals footer, signature strip, and the
// per-page footer + "Page X of Y" stamp.
//
// The render/stamp split mirrors renderDoInto + stampDoFooters so a future
// consolidated CN packing list (Batch 2) can draw several CNs into one doc
// and number the whole document once — same contract as the DO side.
// ---------------------------------------------------------------------------

// All print fields are resolved CLIENT-SIDE by the CN page (hub address /
// contact via customer.deliveryHubs, transport company via the providers
// cache) — there is no CN /print-extras endpoint. Everything is optional
// except the document number; missing fields render "-".
export type CNPdfData = {
  cnNo: string;
  customerName?: string;
  // Deliver-To label — the destination branch (hub shortName, falling back
  // to the CN's free-text branchName).
  deliverTo?: string;
  deliveryAddress?: string;
  // Full state label, already resolved by the caller via resolveStateCode +
  // MALAYSIA_STATES (e.g. "Selangor"). Raw hub shorthand is fine too.
  stateLabel?: string;
  contactPerson?: string;
  contactPhone?: string;
  dispatchDate?: string | null;
  // 3PL transport (denormalized on the CN row by resolveTransport).
  transportCompany?: string;
  driverName?: string;
  driverPhone?: string;
  vehicleNo?: string;
  vehicleType?: string;
  items: {
    productCode?: string;
    productName?: string;
    sizeLabel?: string;
    fabricCode?: string;
    quantity: number;
    // Per-unit m³ (joined from products.unitM3); line total = itemM3 × qty.
    itemM3?: number;
    // Parent CO number for the line (joined from the linked PO).
    consignmentOrderNo?: string;
  }[];
};

// Greyscale only — colour ink is expensive on the floor printer, so the
// whole document is black + greys (same rule as the DO PDF).
const INK: [number, number, number] = [17, 17, 17];
const RULE: [number, number, number] = [0, 0, 0];
const HAIR: [number, number, number] = [120, 120, 120];
const FAINT: [number, number, number] = [110, 110, 110];

// Draws ONE consignment note into an EXISTING jsPDF doc, starting on the
// current page (the table paginates itself; the header reprints per page).
// Footers + "Page X of Y" are NOT applied here — the caller runs
// stampCnFooters() once after all CNs are drawn. The single-CN entry point
// generateCNPdf() below wraps this.
export function renderCnInto(doc: jsPDF, data: CNPdfData) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 14;
  const co = COMPANY.HOOKKA;

  const docDate = fmtDate(data.dispatchDate);
  const driverLine = `${data.driverName || "-"}${
    data.driverPhone ? ` (${data.driverPhone})` : ""
  }`;
  const lorryLine =
    [data.vehicleNo, data.vehicleType]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" · ") || "-";

  // One row taller than the DO header (76 vs 72): the left column carries
  // an extra State line and the right column a Transport Co. line.
  const HEADER_BOTTOM = 76;
  const drawHeader = () => {
    // --- B/W letterhead: logo left, company block beside, title right ---
    addHookkaLetterhead(doc, m, 12, 12);
    const tx = m + 12 * (2038 / 907) + 5;
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(co.name, tx, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(...FAINT);
    doc.text(`Reg. ${co.regNo}   |   TIN ${co.tin}`, tx, 20.5);
    doc.text(co.address, tx, 24);
    doc.text(`Tel ${co.phone}   |   ${co.email}`, tx, 27.5);

    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(17);
    doc.text("CONSIGNMENT NOTE", pageW - m, 17, { align: "right" });
    doc.setFontSize(10.5);
    doc.text(`No. ${data.cnNo}`, pageW - m, 23, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...FAINT);
    doc.text(`${docDate}   |   CONSIGNMENT`, pageW - m, 27.5, {
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
    ly = lblVal(leftX, ly, "Customer", data.customerName || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Deliver To", data.deliverTo || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Address", data.deliveryAddress || "-", leftMaxW);
    ly = lblVal(leftX, ly, "State", data.stateLabel || "-", leftMaxW);
    lblVal(
      leftX,
      ly,
      "Contact",
      `${data.contactPerson || "-"}${data.contactPhone ? ` (${data.contactPhone})` : ""}`,
      leftMaxW,
    );

    const rightX = pageW / 2 + 12;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 38;
    ry = lblVal(rightX, ry, "CN No.", data.cnNo, rightMaxW);
    ry = lblVal(rightX, ry, "Dispatch Date", docDate, rightMaxW);
    ry = lblVal(rightX, ry, "Transport Co.", data.transportCompany || "-", rightMaxW);
    ry = lblVal(rightX, ry, "Driver", driverLine, rightMaxW);
    lblVal(rightX, ry, "Lorry Plate", lorryLine, rightMaxW);

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  // Totals for the table footer row.
  const totalQty = data.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const totalM3 = data.items.reduce(
    (s, it) => s + (Number(it.itemM3) || 0) * (Number(it.quantity) || 0),
    0,
  );

  const body: RowInput[] = data.items.map((it, i) => {
    const lineM3 = (Number(it.itemM3) || 0) * (Number(it.quantity) || 0);
    return [
      String(i + 1),
      it.consignmentOrderNo || "-",
      it.productCode || "-",
      it.productName || "-",
      it.sizeLabel || "-",
      it.fabricCode || "-",
      String(it.quantity ?? 0),
      lineM3 > 0 ? lineM3.toFixed(2) : "-",
    ];
  });

  drawHeader();

  autoTable(doc, {
    head: [
      [
        { content: "#", styles: { halign: "center" } },
        { content: "CO No." },
        { content: "Product Code" },
        { content: "Description" },
        { content: "Size" },
        { content: "Fabric" },
        { content: "Qty", styles: { halign: "right" } },
        { content: "M³", styles: { halign: "right" } },
      ],
    ],
    body,
    foot: [
      [
        { content: "Total", colSpan: 6, styles: { halign: "right" } },
        { content: `${totalQty} PCS`, styles: { halign: "right" } },
        { content: totalM3.toFixed(2), styles: { halign: "right" } },
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    // Never split one item's row across a page break — the whole row moves
    // to the next page instead (same rule as the DO table).
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
      fontSize: 7,
      lineWidth: { top: 0.5, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      0: { cellWidth: 8, halign: "center" }, // #
      1: { cellWidth: 26 }, // CO No.
      2: { cellWidth: 30 }, // Product Code
      3: { cellWidth: "auto" }, // Description (product name)
      4: { cellWidth: 16 }, // Size
      5: { cellWidth: 22 }, // Fabric
      6: { cellWidth: 14, halign: "right" }, // Qty
      7: { cellWidth: 16, halign: "right" }, // M³ (line total)
    },
    didDrawCell: (d) => {
      // Thin dashed separator under every item row (drawn once per row,
      // on the last column) so rows are easy to read across.
      if (d.section === "body" && d.column.index === 7) {
        const y = d.cell.y + d.cell.height;
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

  const afterY =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;

  // Signature strip on the last page — same blocks as the DO.
  let sy = afterY + 16;
  if (sy > pageH - 34) {
    doc.addPage();
    sy = 36;
  }
  const halfW = (pageW - m * 2 - 14) / 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.3);
  doc.line(m, sy + 14, m + halfW, sy + 14);
  doc.line(pageW - m - halfW, sy + 14, pageW - m, sy + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text("Prepared By", m, sy + 19);
  doc.text("Received in Good Order", pageW - m - halfW, sy + 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...FAINT);
  doc.text("Name / Date / Stamp", m, sy + 23.5);
  doc.text("Name / Date / Stamp", pageW - m - halfW, sy + 23.5);
}

// Stamps the per-page footer + "Page X of Y" across the WHOLE document.
// Run exactly once, after all CN(s) have been rendered.
export function stampCnFooters(doc: jsPDF) {
  const m = 14;
  const co = COMPANY.HOOKKA;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
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
      `${co.name} · ${co.regNo} · Computer-generated consignment note`,
      m,
      fy,
    );
    doc.text(`Page ${p} of ${pages}`, pageW - m, fy, { align: "right" });
  }
}

// Single-CN entry point — mirrors generateDOPdf's signature and the
// download/view split (view opens the blob in a tab; popup-blocked windows
// fall back to a download).
export function generateCNPdf(
  data: CNPdfData,
  mode: "download" | "view" = "download",
) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  renderCnInto(doc, data);
  stampCnFooters(doc);

  // cnNo already carries the "CGN-" prefix (e.g. "CGN-2606-001"); use it
  // verbatim and only add the prefix for any legacy number that lacks it
  // (pre-rename CON-* numbers stay as-is too).
  const cnNo = data.cnNo || "";
  const fileName = `${
    cnNo.startsWith("CGN-") || cnNo.startsWith("CON-") ? cnNo : `CGN-${cnNo}`
  }.pdf`;

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
