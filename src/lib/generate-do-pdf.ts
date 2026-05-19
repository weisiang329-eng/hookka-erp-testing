import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { fmtDate, drawLetterhead, drawDocFooter, PDF } from "@/lib/pdf-utils";

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

const dimStr = (v?: number | null) =>
  v == null || Number(v) === 0 ? "-" : `${v}"`;

// Category print order: bedframes first (1..N), then the sofa block, then
// accessories (which always travel with the sofas). Stable within a group.
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
// Delivery Order PDF — premium letterhead + full tabular layout.
// Columns: No | SO No / Cust PO / Ref | Product Code | Product / Variant |
//          Size | Colour / Fabric | Total H | D1 | Gap | Qty | M³
// Bedframe vs Sofa are split into labelled sections; bedframe-only build
// columns (Total H / D1 / Gap) read "-" on sofa/accessory rows. The
// letterhead + reference block + column header repeat on every page.
// ---------------------------------------------------------------------------
export function generateDOPdf(order: DeliveryOrder, extras?: DOPrintExtras) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const m = PDF.margin;
  const o = order as DeliveryOrder & {
    customerPOId?: string;
    hubName?: string;
    hubState?: string;
    customerState?: string;
  };

  const docDate = fmtDate(order.deliveryDate);

  // Deliver-To + address follow the DO's hub (resolved server-side in
  // /print-extras). Fall back to the DO payload only when not supplied.
  const deliverTo =
    extras?.deliverTo || o.hubName || o.hubState || o.customerState || "";
  const deliveryAddress = extras?.deliveryAddress || order.deliveryAddress || "";
  const contactPhone = extras?.hubContactPhone || order.contactPhone || "";
  const contactPerson = extras?.hubContactName || order.contactPerson || "";

  // Customer PO / SO / Ref — distinct set across all lines, for the header.
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
  const headerCustomerPO = o.customerPOId || distinct((x) => x.customerPOId) || "-";
  const headerOurSO =
    distinct((x) => x.salesOrderNo) || order.companySO || "-";
  const headerCustomerSO = extras?.customerSO || "-";
  const headerCustomerRef = extras?.customerRef || "-";

  // ---- repeated per-page header; everything above the items table ----
  const HEADER_BOTTOM = 95;
  const drawHeader = () => {
    // Premium shared letterhead (logo + company + DELIVERY ORDER title).
    drawLetterhead(doc, {
      docTitle: "Delivery Order",
      docNo: order.doNo,
      docDate,
      statusText: "C.O.D.",
    });

    // ---- Reference block: parties (left) + numbers (right) ----
    let ly = 47;
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
      doc.setTextColor(...PDF.muted);
      doc.text(k, x, y);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...PDF.ink);
      const lines = doc.splitTextToSize(v || "-", maxW);
      doc.text(lines, x + labelW, y);
      return y + Math.max(1, lines.length) * 4.4 + 0.6;
    };

    const leftX = m;
    const leftMaxW = (pageW - m * 2) * 0.52 - labelW;
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

    const rightX = pageW / 2 + 8;
    const rightMaxW = pageW - m - rightX - labelW;
    let ry = 47;
    ry = lblVal(rightX, ry, "DO No.", order.doNo, rightMaxW);
    ry = lblVal(rightX, ry, "Our SO", headerOurSO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer SO", headerCustomerSO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer PO", headerCustomerPO, rightMaxW);
    ry = lblVal(rightX, ry, "Customer Ref", headerCustomerRef, rightMaxW);
    ry = lblVal(rightX, ry, "Date", docDate, rightMaxW);
    lblVal(
      rightX,
      ry,
      "Driver",
      `${order.driverName || "-"}${
        order.vehicleNo ? `  ·  ${order.vehicleNo}` : ""
      }`,
      rightMaxW,
    );

    doc.setDrawColor(...PDF.rule);
    doc.setLineWidth(0.3);
    doc.line(m, HEADER_BOTTOM - 3, pageW - m, HEADER_BOTTOM - 3);
  };

  // ---- rows, grouped by category with a band row before each group ----
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
      // Category band row spanning the whole table — makes the
      // bedframe / sofa split visible at a glance.
      body.push([
        {
          content: catLabel(cat),
          colSpan: 11,
          styles: {
            fontStyle: "bold",
            fontSize: 7.4,
            fillColor: [238, 234, 226],
            textColor: PDF.accent,
            halign: "left",
          },
        },
      ]);
      lastCat = cat;
    }
    runningNo += 1;

    // Stacked reference cell: our SO / customer PO / customer Ref.
    const refCell = [
      ex?.salesOrderNo || it.salesOrderNo || order.companySO || "-",
      ex?.customerPOId ? `PO ${ex.customerPOId}` : "",
      extras?.customerRef ? `Ref ${extras.customerRef}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Product / Variant cell: name + special order note when present.
    const variant = [
      it.productName || "-",
      ex?.specialOrder ? `* ${ex.specialOrder}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Colour / Fabric cell — append leg height for sofa so the customer
    // sees the full sofa variant without a bedframe-only column.
    const legTxt = dimStr(ex?.legHeightInches);
    const fabricCell =
      !isBF && legTxt !== "-"
        ? `${it.fabricCode || "-"}\n${legTxt} LEG`
        : it.fabricCode || "-";

    body.push([
      String(runningNo),
      refCell,
      it.productCode || "-",
      variant,
      it.sizeLabel || "-",
      fabricCell,
      dimStr(ex?.totalHeightInches),
      isBF ? dimStr(ex?.divanHeightInches) : "-",
      isBF ? dimStr(ex?.gapInches) : "-",
      String(it.quantity),
      ((it.itemM3 || 0) * it.quantity).toFixed(2),
    ]);
  }

  drawHeader();

  autoTable(doc, {
    head: [
      [
        "No",
        "SO No. / Cust PO / Ref",
        "Product Code",
        "Product / Variant",
        "Size",
        "Colour / Fabric",
        "Total H",
        "D1",
        "Gap",
        "Qty",
        "M³",
      ],
    ],
    body,
    foot: [
      ["", "", "", "", "", "", "", "", "Total", String(totalQty), totalM3.toFixed(2)],
    ],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 16 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7.3,
      cellPadding: { top: 1.4, bottom: 1.4, left: 1.6, right: 1.6 },
      textColor: PDF.ink,
      lineColor: PDF.rule,
      lineWidth: 0.15,
      valign: "top",
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: PDF.accent,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 7,
      halign: "center",
      lineColor: PDF.accent,
    },
    footStyles: {
      fillColor: [245, 243, 239],
      textColor: PDF.ink,
      fontStyle: "bold",
      fontSize: 7.6,
      halign: "right",
    },
    columnStyles: {
      0: { cellWidth: 7, halign: "center" },
      1: { cellWidth: 30 },
      2: { cellWidth: 22 },
      3: { cellWidth: "auto" },
      4: { cellWidth: 12, halign: "center" },
      5: { cellWidth: 22 },
      6: { cellWidth: 12, halign: "center" },
      7: { cellWidth: 11, halign: "center" },
      8: { cellWidth: 11, halign: "center" },
      9: { cellWidth: 11, halign: "right" },
      10: { cellWidth: 14, halign: "right" },
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
  let sy = lastY + 16;
  const pageH = doc.internal.pageSize.getHeight();
  if (sy > pageH - 34) {
    doc.addPage();
    sy = 40;
  }
  const halfW = (pageW - m * 2 - 12) / 2;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  doc.line(m, sy + 14, m + halfW, sy + 14);
  doc.line(pageW - m - halfW, sy + 14, pageW - m, sy + 14);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...PDF.ink);
  doc.text("Prepared By", m, sy + 19);
  doc.text("Received in Good Order", pageW - m - halfW, sy + 19);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...PDF.muted);
  doc.text("Name / Date / Stamp", m, sy + 23.5);
  doc.text("Name / Date / Stamp", pageW - m - halfW, sy + 23.5);

  // Consistent footer on every page.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawDocFooter(doc);
  }

  doc.save(`DO-${order.doNo}.pdf`);
}
