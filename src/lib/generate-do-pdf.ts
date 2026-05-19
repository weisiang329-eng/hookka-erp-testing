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
      specialOrder?: string | null; // e.g. "Headboard Only"
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
const GRID: [number, number, number] = [120, 120, 120];
const BAND: [number, number, number] = [232, 232, 232];
const HEADBG: [number, number, number] = [38, 38, 38];
const FAINT: [number, number, number] = [110, 110, 110];

const dash = (s?: string | null) => (s && String(s).trim() ? String(s) : "-");
const dimStr = (v?: number | null) =>
  v == null || Number(v) === 0 ? "-" : `${v}"`;

// Variant = the bit of the product code after the first "-" (mirrors the
// in-app items table, e.g. "1005-(Q)" -> "(Q)").
const variantOf = (code?: string) => {
  const c = code || "";
  const i = c.indexOf("-");
  return i >= 0 ? c.slice(i + 1) : "-";
};

// Category print order: bedframes first, then sofa, then accessory
// (accessories always travel with the sofas). Stable within a group.
const catRank = (cat?: string | null): number => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return 0;
  if (c === "SOFA") return 1;
  if (c === "ACCESSORY") return 2;
  return 3;
};
const catLabel = (cat?: string | null): string => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return "BEDFRAME";
  if (c === "SOFA") return "SOFA";
  if (c === "ACCESSORY") return "ACCESSORY / ADD-ON";
  return "OTHER";
};

// ---------------------------------------------------------------------------
// Delivery Order PDF — black & white, A4 LANDSCAPE, one wide row per item
// (no stacked cells / no 2-line wrap). Columns mirror the on-screen items
// table the operator approved, plus the bedframe build spec:
//   No | SO ID | Customer PO | Customer SO | Customer Ref | Product Code |
//   Variant | Product Name | Size | Colour/Fabric | Divan | Gap | Total H |
//   Special Order | Qty | M3
// Letterhead + reference block + column header repeat on every page.
// ---------------------------------------------------------------------------
export function generateDOPdf(order: DeliveryOrder, extras?: DOPrintExtras) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const m = 12;
  const co = COMPANY.HOOKKA;
  const o = order as DeliveryOrder & {
    customerPOId?: string;
    hubName?: string;
    hubState?: string;
    customerState?: string;
  };

  const docDate = fmtDate(order.deliveryDate);
  const deliverTo =
    extras?.deliverTo || o.hubName || o.hubState || o.customerState || "";
  const deliveryAddress =
    extras?.deliveryAddress || order.deliveryAddress || "";
  const contactPerson = extras?.hubContactName || order.contactPerson || "";
  const contactPhone = extras?.hubContactPhone || order.contactPhone || "";

  const distinct = (pick: (x: ItemExtra) => string | null | undefined) =>
    extras?.items
      ? Array.from(
          new Set(
            Object.values(extras.items)
              .map((x) => (pick(x) || "").trim())
              .filter(Boolean),
          ),
        ).join(", ")
      : "";
  const headerCustomerPO =
    o.customerPOId || distinct((x) => x.customerPOId) || "-";
  const headerOurSO = distinct((x) => x.salesOrderNo) || order.companySO || "-";
  const headerCustomerSO =
    extras?.customerSO || distinct((x) => x.customerSO) || "-";
  const headerCustomerRef =
    extras?.customerRef || distinct((x) => x.customerRef) || "-";

  const HEADER_BOTTOM = 64;
  const drawHeader = () => {
    // --- B/W letterhead: logo left, company block beside, title right ---
    addHookkaLetterhead(doc, m, 10, 12);
    const tx = m + 12 * (2038 / 907) + 5;
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(co.name, tx, 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...FAINT);
    doc.text(`Reg. ${co.regNo}   |   TIN ${co.tin}`, tx, 18.5);
    doc.text(co.address, tx, 22.5);
    doc.text(`Tel ${co.phone}   |   ${co.email}`, tx, 26.5);

    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("DELIVERY ORDER", pageW - m, 16, { align: "right" });
    doc.setFontSize(11);
    doc.text(`No. ${order.doNo}`, pageW - m, 23, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...FAINT);
    doc.text(`${docDate}   |   C.O.D.`, pageW - m, 28, { align: "right" });

    doc.setDrawColor(...INK);
    doc.setLineWidth(0.5);
    doc.line(m, 31, pageW - m, 31);

    // --- Reference block: parties (left) + numbers (right) ---
    const labelW = 24;
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
      return y + Math.max(1, lines.length) * 4.2 + 0.6;
    };

    const leftX = m;
    const leftMaxW = pageW * 0.42 - labelW;
    let ly = 37;
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

    const rightX = pageW * 0.56;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 37;
    ry = lblVal(rightX, ry, "DO No.", order.doNo, rightMaxW);
    ry = lblVal(rightX, ry, "Our SO", headerOurSO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer PO", headerCustomerPO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer SO", headerCustomerSO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer Ref", headerCustomerRef, rightMaxW);
    lblVal(
      rightX,
      ry,
      "Driver",
      `${order.driverName || "-"}${
        order.vehicleNo ? `  ·  ${order.vehicleNo}` : ""
      }`,
      rightMaxW,
    );

    doc.setDrawColor(...GRID);
    doc.setLineWidth(0.3);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  const totalM3 = order.items.reduce(
    (s, i) => s + (i.itemM3 || 0) * i.quantity,
    0,
  );

  const ordered = order.items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        catRank(extras?.items?.[a.it.id]?.itemCategory) -
          catRank(extras?.items?.[b.it.id]?.itemCategory) || a.i - b.i,
    )
    .map((x) => x.it);

  const body: RowInput[] = [];
  let runningNo = 0;
  let lastCat: string | null = null;
  for (const it of ordered) {
    const ex = extras?.items?.[it.id];
    const cat = (ex?.itemCategory || "").toUpperCase();
    const isBF = cat === "BEDFRAME";
    if (cat !== lastCat && extras?.items) {
      body.push([
        {
          content: catLabel(cat),
          colSpan: 16,
          styles: {
            fontStyle: "bold",
            fontSize: 7.6,
            fillColor: BAND,
            textColor: INK,
            halign: "left",
          },
        },
      ]);
      lastCat = cat;
    }
    runningNo += 1;
    body.push([
      String(runningNo),
      dash(ex?.salesOrderNo || it.salesOrderNo || order.companySO),
      dash(ex?.customerPOId),
      dash(ex?.customerSO || extras?.customerSO),
      dash(ex?.customerRef || extras?.customerRef),
      dash(it.productCode),
      variantOf(it.productCode),
      dash(it.productName),
      dash(it.sizeLabel),
      dash(it.fabricCode),
      isBF ? dimStr(ex?.divanHeightInches) : "-",
      isBF ? dimStr(ex?.gapInches) : "-",
      dimStr(ex?.totalHeightInches),
      dash(ex?.specialOrder),
      String(it.quantity),
      ((it.itemM3 || 0) * it.quantity).toFixed(2),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    head: [
      [
        "No",
        "SO ID",
        "Customer PO",
        "Customer SO",
        "Customer Ref",
        "Product Code",
        "Variant",
        "Product Name",
        "Size",
        "Colour / Fabric",
        "Divan",
        "Gap",
        "Total H",
        "Special Order",
        "Qty",
        "M³",
      ],
    ],
    body,
    foot: [
      [
        { content: "Total", colSpan: 14, styles: { halign: "right" } },
        String(totalQty),
        totalM3.toFixed(2),
      ],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 14 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 6.8,
      cellPadding: { top: 1.3, bottom: 1.3, left: 1.4, right: 1.4 },
      textColor: INK,
      lineColor: GRID,
      lineWidth: 0.15,
      valign: "top",
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: HEADBG,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 6.6,
      halign: "center",
      lineColor: HEADBG,
    },
    footStyles: {
      fillColor: [240, 240, 240],
      textColor: INK,
      fontStyle: "bold",
      fontSize: 7.2,
      halign: "right",
    },
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: 22 },
      2: { cellWidth: 22 },
      3: { cellWidth: 22 },
      4: { cellWidth: 20 },
      5: { cellWidth: 22 },
      6: { cellWidth: 14, halign: "center" },
      7: { cellWidth: "auto" },
      8: { cellWidth: 13, halign: "center" },
      9: { cellWidth: 22 },
      10: { cellWidth: 13, halign: "center" },
      11: { cellWidth: 12, halign: "center" },
      12: { cellWidth: 14, halign: "center" },
      13: { cellWidth: 24 },
      14: { cellWidth: 12, halign: "right" },
      15: { cellWidth: 16, halign: "right" },
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

  // Signature strip on the last page.
  const lastY =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? HEADER_BOTTOM;
  const pageH = doc.internal.pageSize.getHeight();
  let sy = lastY + 14;
  if (sy > pageH - 30) {
    doc.addPage();
    sy = 30;
  }
  const halfW = (pageW - m * 2 - 16) / 2;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.3);
  doc.line(m, sy + 13, m + halfW, sy + 13);
  doc.line(pageW - m - halfW, sy + 13, pageW - m, sy + 13);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...INK);
  doc.text("Prepared By", m, sy + 18);
  doc.text("Received in Good Order", pageW - m - halfW, sy + 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...FAINT);
  doc.text("Name / Date / Stamp", m, sy + 22.5);
  doc.text("Name / Date / Stamp", pageW - m - halfW, sy + 22.5);

  // Footer note on every page.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = pageH - 8;
    doc.setDrawColor(...GRID);
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
