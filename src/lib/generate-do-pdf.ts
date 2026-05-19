import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { COMPANY } from "@/lib/constants";
import { fmtDate, addHookkaLetterhead } from "@/lib/pdf-utils";

// Read-only print-extras from GET /api/delivery-orders/:id/print-extras.
// All optional — the PDF still renders if not supplied.
export type DOPrintExtras = {
  customerSO?: string;
  customerRef?: string;
  // Deliver-To resolved from the DO's hub (a customer can have many hubs,
  // each with its own address — the printed address must follow the hub).
  deliverTo?: string;
  deliveryAddress?: string;
  hubState?: string;
  hubContactName?: string;
  hubContactPhone?: string;
  items?: Record<
    string,
    {
      itemCategory?: string | null; // SOFA / BEDFRAME / ACCESSORY
      customerPOId?: string | null; // customer's PO no. for this line
      customerSO?: string | null; // customer's own SO no. for this line
      customerRef?: string | null; // customer's ERP reference for this line
      salesOrderNo?: string | null; // our SO no. for this line
      specialOrder?: string | null; // e.g. "Headboard Only" / "DIVAN CURVE"
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
    }
  >;
};

type ItemExtra = NonNullable<DOPrintExtras["items"]>[string];

// Greyscale only — colour ink is expensive on the floor printer, so the
// whole document is black + greys (Wei Siang).
const INK: [number, number, number] = [17, 17, 17];
const RULE: [number, number, number] = [0, 0, 0];
const HAIR: [number, number, number] = [120, 120, 120];
const BAND: [number, number, number] = [232, 232, 232];
const FAINT: [number, number, number] = [110, 110, 110];

const num = (v?: number | null) =>
  v == null || Number(v) === 0 ? null : `${v}"`;

// Print order: bedframes first, then the sofa block, then accessories
// (always travel WITH the sofas), then service items grouped at the end.
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
const uomOf = (cat?: string | null) =>
  (cat || "").toUpperCase() === "ACCESSORY" ? "UNIT" : "SET";

// Stacked Description cell — the standard furniture DO line shape:
//   line 1  product code              e.g. 2008(A)-(K)
//   line 2  product name (w/ size)    e.g. TRION(A) (HB STRAIGHT) BEDFRAME (6FT) (183X190CM)
//   line 3  build spec               BF : PC151-02 / DIVAN 12" + 2" LEG / TH 14"
//                                     SOFA: BO315-21 / 35
// (PO / SO / Reference are their own columns now, not in the description.)
function describe(
  it: {
    productCode: string;
    productName: string;
    fabricCode: string;
    sizeLabel: string;
  },
  ex: ItemExtra | undefined,
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

  // Treat it as a bedframe-style spec whenever it's tagged BEDFRAME OR it
  // carries a divan / leg / gap / total-height value — so the build spec
  // (D1 / Total H / Mattress Gap) still prints even when itemCategory was
  // never stamped on the order.
  const hasBfSpec = !!(dv || lg || gp || th);
  if (cat === "BEDFRAME" || (cat !== "SOFA" && cat !== "ACCESSORY" && hasBfSpec)) {
    if (dv) spec.push(`DIVAN ${dv}${lg ? ` + ${lg} LEG` : " + NO LEG"}`);
    else if (lg) spec.push(`${lg} LEG`);
    if (gp) spec.push(`GAP ${gp}`);
    if (th) spec.push(`T.Heights ${th}`);
  } else {
    // sofa / accessory — seat size, then any leg / total height it has
    if (it.sizeLabel) spec.push(it.sizeLabel);
    if (lg) spec.push(`${lg} LEG`);
    if (th) spec.push(`T.Heights ${th}`);
  }
  if (ex?.specialOrder && String(ex.specialOrder).trim())
    spec.push(String(ex.specialOrder).trim());
  if (spec.length) lines.push(spec.join(" / "));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delivery Order PDF — A4 PORTRAIT, black & white. The standard furniture
// DO line shape: Item | Description (stacked code / name / spec / (PO)) |
// UOM | Qty. Bedframes / sofas / accessories print as labelled sections.
// Letterhead + reference block + column header repeat on every page.
// ---------------------------------------------------------------------------
export function generateDOPdf(order: DeliveryOrder, extras?: DOPrintExtras) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 14;
  const co = COMPANY.HOOKKA;
  const o = order as DeliveryOrder & {
    customerPOId?: string;
    hubName?: string;
    hubState?: string;
    customerState?: string;
    driverPhone?: string;
    vehicleType?: string;
    lorryName?: string;
  };

  const docDate = fmtDate(order.deliveryDate);
  const deliverTo =
    extras?.deliverTo || o.hubName || o.hubState || o.customerState || "";
  const deliveryAddress =
    extras?.deliveryAddress || order.deliveryAddress || "";
  const contactPerson = extras?.hubContactName || order.contactPerson || "";
  const contactPhone = extras?.hubContactPhone || order.contactPhone || "";

  // Driver + lorry dispatch info for the header (operator wants the
  // lorry plate visible, not just the driver name).
  const driverLine = `${order.driverName || "-"}${
    o.driverPhone ? ` (${o.driverPhone})` : ""
  }`;
  const lorryLine =
    [order.vehicleNo, o.vehicleType, o.lorryName]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" · ") || "-";

  const HEADER_BOTTOM = 72;
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
    doc.text("DELIVERY ORDER", pageW - m, 17, { align: "right" });
    doc.setFontSize(10.5);
    doc.text(`No. ${order.doNo}`, pageW - m, 23, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...FAINT);
    doc.text(`${docDate}   |   C.O.D.`, pageW - m, 27.5, { align: "right" });

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
    ly = lblVal(leftX, ly, "Customer", order.customerName || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Deliver To", deliverTo || "-", leftMaxW);
    ly = lblVal(leftX, ly, "Address", deliveryAddress || "-", leftMaxW);
    lblVal(
      leftX,
      ly,
      "Contact",
      `${contactPerson || "-"}${contactPhone ? ` (${contactPhone})` : ""}`,
      leftMaxW,
    );

    const rightX = pageW / 2 + 12;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 38;
    ry = lblVal(rightX, ry, "DO No.", order.doNo, rightMaxW);
    ry = lblVal(rightX, ry, "Date", docDate, rightMaxW);
    ry = lblVal(rightX, ry, "Driver", driverLine, rightMaxW);
    lblVal(rightX, ry, "Lorry Plate", lorryLine, rightMaxW);

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);

  // Total by UOM ("7 SET", or "5 SET · 2 UNIT") + a headboard / divan
  // breakdown across the bedframe lines. A normal bedframe ships as
  // HB + Divan; a DIVAN-only SKU is divan-only; a "Headboard Only"
  // special is HB-only.
  const uomCount: Record<string, number> = {};
  let hbPcs = 0;
  let divanPcs = 0;
  for (const it of order.items) {
    const ex = extras?.items?.[it.id];
    const u = uomOf(ex?.itemCategory);
    uomCount[u] = (uomCount[u] || 0) + it.quantity;
    const cat = (ex?.itemCategory || "").toUpperCase();
    const code = (it.productCode || "").toUpperCase();
    const name = (it.productName || "").toUpperCase();
    const sp = (ex?.specialOrder || "").toLowerCase();
    const isBed =
      cat === "BEDFRAME" ||
      name.includes("BEDFRAME") ||
      code.startsWith("DIVAN") ||
      name.startsWith("DIVAN");
    if (!isBed) continue;
    const divanOnly = code.startsWith("DIVAN") || name.startsWith("DIVAN");
    const hbOnly = sp.includes("headboard only") || sp.includes("hb only");
    if (divanOnly) divanPcs += it.quantity;
    else if (hbOnly) hbPcs += it.quantity;
    else {
      hbPcs += it.quantity;
      divanPcs += it.quantity;
    }
  }
  const uomSummary =
    Object.entries(uomCount)
      .map(([u, n]) => `${n} ${u}`)
      .join("  ·  ") || `${totalQty}`;
  const pieceSummary =
    hbPcs || divanPcs
      ? `Bedframe pieces:  ${hbPcs} HB  +  ${divanPcs} DIVAN`
      : "";

  const ordered = order.items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        catRank(extras?.items?.[a.it.id]?.itemCategory) -
          catRank(extras?.items?.[b.it.id]?.itemCategory) || a.i - b.i,
    )
    .map((x) => x.it);

  const body: RowInput[] = [];
  let lastCat: string | null = null;
  for (const it of ordered) {
    const ex = extras?.items?.[it.id];
    const cat = (ex?.itemCategory || "").toUpperCase();
    if (cat !== lastCat && extras?.items) {
      body.push([
        {
          content: catLabel(cat),
          colSpan: 7,
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
    const itx = it as typeof it & { salesOrderNo?: string };
    body.push([
      ex?.salesOrderNo || itx.salesOrderNo || order.companySO || "-",
      describe(
        {
          productCode: it.productCode || "",
          productName: it.productName || "",
          fabricCode: it.fabricCode || "",
          sizeLabel: it.sizeLabel || "",
        },
        ex,
      ),
      (ex?.customerPOId && String(ex.customerPOId).trim()) || "-",
      (
        (ex?.customerSO && String(ex.customerSO).trim()) ||
        (extras?.customerSO && String(extras.customerSO).trim()) ||
        "-"
      ),
      // Company SO — Hookka's own SO number for this line.
      ex?.salesOrderNo || itx.salesOrderNo || order.companySO || "-",
      uomOf(ex?.itemCategory),
      String(it.quantity),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    head: [
      [
        "CS Order No.",
        "Description",
        "PO",
        "Supplier SO",
        "Company SO",
        "UOM",
        "Qty",
      ],
    ],
    body,
    foot: [
      [
        { content: "Total", colSpan: 5, styles: { halign: "right" } },
        {
          content: uomSummary,
          colSpan: 2,
          styles: { halign: "right" },
        },
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: { top: 1.4, bottom: 2, left: 2, right: 2 },
      textColor: INK,
      lineColor: HAIR,
      lineWidth: 0,
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 8.5,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: RULE,
    },
    footStyles: {
      fontStyle: "bold",
      fontSize: 9,
      lineWidth: { top: 0.5, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      // CS Order No. — our SO/CS number per line (replaces the old #).
      0: { cellWidth: 26, fontStyle: "bold" },
      // Description nudged right a touch (extra left padding) so it
      // doesn't sit flush against the order number.
      1: { cellWidth: "auto", cellPadding: { top: 1.4, bottom: 2, left: 4, right: 2 } },
      2: { cellWidth: 22 }, // PO
      3: { cellWidth: 22 }, // SO
      4: { cellWidth: 20 }, // Reference
      5: { cellWidth: 14, halign: "center" }, // UOM
      6: { cellWidth: 12, halign: "right" }, // Qty
    },
    didParseCell: (data) => {
      // First line (product code) of the Description reads a touch heavier.
      if (
        data.section === "body" &&
        data.column.index === 1 &&
        typeof data.cell.raw === "string"
      ) {
        data.cell.styles.fontSize = 8.3;
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

  // Headboard / divan piece breakdown for bedframes.
  const lastY0 =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;
  let afterY = lastY0;
  if (pieceSummary) {
    let py = lastY0 + 6;
    if (py > pageH - 40) {
      doc.addPage();
      py = 30;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...INK);
    doc.text(pieceSummary, m, py);
    afterY = py;
  }

  // Signature strip on the last page.
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

  // Footer note on every page.
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
      `${co.name} · ${co.regNo} · Computer-generated delivery order`,
      m,
      fy,
    );
    doc.text(`Page ${p} of ${pages}`, pageW - m, fy, { align: "right" });
  }

  doc.save(`DO-${order.doNo}.pdf`);
}
