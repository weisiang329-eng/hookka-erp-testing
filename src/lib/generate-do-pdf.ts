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
      pieces?: string | null; // BOM set composition, e.g. "1 HB + 2 DIVAN"
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

// "2 DIVAN + 1 HB" -> { text: "1 HB  +  2 DIVAN", total: 3 } (HB first).
function fmtPieces(pieces?: string | null): { text: string; total: number } {
  const parts = String(pieces || "")
    .split(" + ")
    .map((s) => s.trim())
    .filter(Boolean);
  let total = 0;
  const parsed = parts.map((p) => {
    const mm = p.match(/^(\d+)\s+(.+)$/);
    const n = mm ? Number(mm[1]) : 0;
    total += n;
    return { n, lab: mm ? mm[2] : p };
  });
  const rank = (lab: string) => {
    const u = lab.toUpperCase();
    return u === "HB" ? 0 : u === "DIVAN" ? 1 : 2;
  };
  parsed.sort((a, b) => rank(a.lab) - rank(b.lab));
  return {
    text: parsed.map((x) => `${x.n} ${x.lab}`).join("  +  "),
    total,
  };
}

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
  // Piece composition is its own Quantity column now (not in here).
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

  // Grand totals for the footer: total sets + total physical pieces.
  let totalSets = 0;
  let totalPcsAll = 0;
  for (const it of order.items) {
    totalSets += it.quantity;
    const fp = fmtPieces(extras?.items?.[it.id]?.pieces);
    totalPcsAll += fp.total || it.quantity;
  }
  // NOTE: the per-piece HB / Divan / sofa-set breakdown is intentionally
  // Per-category roll-up for the bottom Set / Quantity / Total Qty
  // table. Piece counts come from each line's BOM-derived `pieces`
  // string (format we control: "N LABEL + N LABEL", already x line qty).
  const summary = new Map<
    string,
    { sets: number; pcs: Map<string, number>; order: string[] }
  >();
  for (const it of order.items) {
    const ex = extras?.items?.[it.id];
    const cat = catLabel(ex?.itemCategory);
    let rec = summary.get(cat);
    if (!rec) {
      rec = { sets: 0, pcs: new Map(), order: [] };
      summary.set(cat, rec);
    }
    rec.sets += it.quantity;
    if (ex?.pieces) {
      for (const part of String(ex.pieces).split(" + ")) {
        const mm = part.trim().match(/^(\d+)\s+(.+)$/);
        if (!mm) continue;
        const lab = mm[2].trim();
        if (!rec.pcs.has(lab)) rec.order.push(lab);
        rec.pcs.set(lab, (rec.pcs.get(lab) || 0) + Number(mm[1]));
      }
    }
  }
  const summaryRows: string[][] = [];
  for (const [cat, rec] of summary) {
    const breakdown = rec.order
      .map((lab) => `${rec.pcs.get(lab)} ${lab}`)
      .join(" + ");
    const totalPcs = Array.from(rec.pcs.values()).reduce((s, n) => s + n, 0);
    summaryRows.push([
      `${cat} — ${rec.sets} SET`,
      breakdown || "-",
      totalPcs ? `${totalPcs} PCS` : "-",
    ]);
  }

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
    const fp = fmtPieces(ex?.pieces);
    const qtyTxt = fp.text || uomOf(ex?.itemCategory);
    const totQty = fp.total || it.quantity;
    // Customer order refs go in their OWN leading "Order" column,
    // stacked PO / REF / SO, only the lines that have a value.
    const custSO =
      (ex?.customerSO && String(ex.customerSO).trim()) ||
      (extras?.customerSO && String(extras.customerSO).trim()) ||
      "";
    const custPO = (ex?.customerPOId && String(ex.customerPOId).trim()) || "";
    const custRef =
      (ex?.customerRef && String(ex.customerRef).trim()) ||
      (extras?.customerRef && String(extras.customerRef).trim()) ||
      "";
    const refLines: string[] = [];
    if (custPO) refLines.push(`PO: ${custPO}`);
    if (custRef) refLines.push(`REF: ${custRef}`);
    if (custSO) refLines.push(`SO: ${custSO}`);
    const desc = describe(
      {
        productCode: it.productCode || "",
        productName: it.productName || "",
        fabricCode: it.fabricCode || "",
        sizeLabel: it.sizeLabel || "",
      },
      ex,
    );
    body.push([
      refLines.length ? refLines.join("\n") : "-",
      desc,
      String(it.quantity),
      qtyTxt,
      String(totQty),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    head: [["Order", "Description", "Set", "Quantity", "Total Qty"]],
    body,
    foot: [
      [
        { content: "Total", colSpan: 2, styles: { halign: "right" } },
        { content: `${totalSets}`, styles: { halign: "center" } },
        "",
        { content: `${totalPcsAll}`, styles: { halign: "right" } },
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 7.6,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: INK,
      lineColor: HAIR,
      lineWidth: 0,
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 7.4,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: RULE,
    },
    footStyles: {
      fontStyle: "bold",
      fontSize: 8,
      lineWidth: { top: 0.5, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      0: { cellWidth: 34 }, // Order — stacked PO / REF / SO
      1: { cellWidth: "auto" }, // Description (code / name / spec)
      2: { cellWidth: 14, halign: "center" }, // Set (no. of sets)
      3: { cellWidth: 40 }, // Quantity (piece breakdown)
      4: { cellWidth: 18, halign: "right" }, // Total Qty (pcs)
    },
    didParseCell: (data) => {
      // Description is column 1 now.
      if (
        data.section === "body" &&
        data.column.index === 1 &&
        typeof data.cell.raw === "string"
      ) {
        data.cell.styles.fontSize = 7.6;
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

  // Piece roll-up: Set | Quantity (piece breakdown) | Total Qty —
  // one row per category (bedframe, sofa, accessory …).
  const lastY0 =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;
  let afterY = lastY0;
  if (summaryRows.length > 0) {
    autoTable(doc, {
      startY: lastY0 + 7,
      head: [["Set", "Quantity (pieces)", "Total Qty"]],
      body: summaryRows,
      margin: { left: m, right: m, bottom: 14 },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 7.6,
        cellPadding: { top: 1.6, bottom: 1.6, left: 2, right: 2 },
        textColor: INK,
        lineColor: HAIR,
        lineWidth: 0.15,
        valign: "middle",
      },
      headStyles: {
        fontStyle: "bold",
        fontSize: 7.4,
        fillColor: BAND,
        textColor: INK,
        lineColor: HAIR,
        lineWidth: 0.15,
      },
      columnStyles: {
        0: { cellWidth: 48, fontStyle: "bold" },
        1: { cellWidth: "auto" },
        2: { cellWidth: 26, halign: "right", fontStyle: "bold" },
      },
    });
    afterY =
      (doc as unknown as { lastAutoTable?: { finalY?: number } })
        .lastAutoTable?.finalY ?? lastY0 + 7;
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
