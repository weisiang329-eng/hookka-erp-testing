import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import {
  fmtDate,
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  tableTheme,
  PDF,
} from "@/lib/pdf-utils";

// Read-only print-extras (customerSO / customerRef / per-item bedframe
// build params) fetched by the caller from
// GET /api/delivery-orders/:id/print-extras. All optional — the PDF still
// renders cleanly (cells show "-") if not supplied.
export type DOPrintExtras = {
  customerSO?: string;
  customerRef?: string;
  items?: Record<
    string,
    {
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
    }
  >;
};

// Fixed origin warehouse — Hookka is single-warehouse; the "from" branch
// isn't modelled in the schema (option 1A), so it's a static label.
const WAREHOUSE = "Hookka HQ, Sungai Buloh, Selangor";

const dimTxt = (v?: number | null) =>
  v == null || v === 0 ? "" : `${v}"`;

// ---------------------------------------------------------------------------
// Delivery Order PDF — the reference template for the unified, formal
// company document system. Every other generate-*-pdf.ts mirrors this
// (shared letterhead / table theme / footer from pdf-utils.ts).
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

  // ---- Premium shared letterhead ----
  let y = drawLetterhead(doc, {
    docTitle: "Delivery Order",
    docNo: order.doNo,
    docDate: fmtDate(order.deliveryDate),
    statusText: order.status ? order.status.replace(/_/g, " ") : undefined,
  });

  // ---- Parties / references — two ruled columns ----
  const colGap = 8;
  const colW = (pageW - m * 2 - colGap) / 2;
  const xL = m;
  const xR = m + colW + colGap;
  const topY = y;

  const label = (t: string, x: number, yy: number) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...PDF.muted);
    doc.text(t, x, yy);
  };
  const value = (t: string, x: number, yy: number, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...PDF.ink);
    doc.text(t || "-", x + 30, yy);
  };

  y = drawSectionLabel(doc, "Deliver To", y);
  const leftRows: Array<[string, string, boolean?]> = [
    ["Customer", order.customerName, true],
    ["Branch / State", o.hubName || o.hubState || o.customerState || "-"],
    ["Address", order.deliveryAddress || "-"],
    ["Contact", order.contactPerson || "-"],
    ["Phone", order.contactPhone || "-"],
    ["From", WAREHOUSE],
  ];
  let yl = y;
  for (const [k, v, b] of leftRows) {
    label(k, xL, yl);
    if (k === "Address") {
      const lines = doc.splitTextToSize(String(v || "-"), colW - 32);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...PDF.ink);
      doc.text(lines, xL + 30, yl);
      yl += Math.max(1, lines.length) * 4 + 1.5;
    } else {
      value(String(v), xL, yl, b);
      yl += 5.5;
    }
  }

  let yr = drawSectionLabel(doc, "References", topY);
  const rightRows: Array<[string, string, boolean?]> = [
    ["DO No.", order.doNo, true],
    ["Our SO", order.companySOId || "-"],
    ["Customer SO", extras?.customerSO || "-"],
    ["Customer PO", o.customerPOId || "-"],
    ["Customer Ref", extras?.customerRef || "-"],
    ["DO Date", fmtDate(order.deliveryDate)],
    ["Driver", order.driverName || "-"],
    ["Vehicle", order.vehicleNo || "-"],
  ];
  for (const [k, v, b] of rightRows) {
    label(k, xR, yr);
    value(String(v), xR, yr, b);
    yr += 5.5;
  }

  y = Math.max(yl, yr) + 4;

  // ---- Items ----
  y = drawSectionLabel(doc, "Items Delivered", y);
  const isPacking = false; // DO mode; packing list adds a Rack column
  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);

  const body = order.items.map((it, idx) => {
    const itx = it as DeliveryOrder["items"][number] & {
      salesOrderNo?: string;
    };
    const ex = extras?.items?.[it.id];
    const build = ex
      ? [
          ex.totalHeightInches
            ? `TH ${dimTxt(ex.totalHeightInches)}`
            : "",
          ex.divanHeightInches ? `D1 ${dimTxt(ex.divanHeightInches)}` : "",
          ex.gapInches ? `Gap ${dimTxt(ex.gapInches)}` : "",
        ]
          .filter(Boolean)
          .join("  ")
      : "";
    return [
      String(idx + 1),
      itx.salesOrderNo || "-",
      // Description sits UNDER the product code in the same cell.
      `${it.productCode}\n${it.productName}`,
      it.sizeLabel || "-",
      it.fabricCode || "-",
      build || "-",
      String(it.quantity),
      (Number((it as { itemM3?: number }).itemM3) || 0 ? "" : "") +
        ((Number((it as { itemM3?: number }).itemM3) || 0) *
          it.quantity).toFixed(2),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: m, right: m },
    head: [
      [
        "#",
        "SO No.",
        "Product Code / Description",
        "Size",
        "Fabric",
        "Build (TH / D1 / Gap)",
        "Qty",
        "M³",
      ],
    ],
    body,
    foot: [["", "", "", "", "", "Total", String(totalQty), order.totalM3.toFixed(2)]],
    ...tableTheme(),
    columnStyles: {
      0: { cellWidth: 7, halign: "center" },
      1: { cellWidth: 22, overflow: "ellipsize", fontStyle: "bold" },
      2: { cellWidth: "auto", fontStyle: "bold" },
      3: { cellWidth: 16 },
      4: { cellWidth: 22, overflow: "ellipsize" },
      5: { cellWidth: 26, fontSize: 6.8 },
      6: { cellWidth: 11, halign: "right" },
      7: { cellWidth: 14, halign: "right" },
    },
    // Description line (2nd line of the Product cell) renders lighter.
    didParseCell: (data) => {
      if (
        data.section === "body" &&
        data.column.index === 2 &&
        typeof data.cell.raw === "string"
      ) {
        data.cell.styles.fontSize = 7.3;
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 7;
  void isPacking;

  // ---- Remarks ----
  if (order.remarks) {
    doc.setDrawColor(...PDF.rule);
    doc.setLineWidth(0.3);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...PDF.accent);
    doc.text("REMARKS", m, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...PDF.muted);
    const rl = doc.splitTextToSize(order.remarks, pageW - m * 2);
    doc.text(rl, m, y + 4.5);
    y += 6 + rl.length * 4;
  }

  // ---- Signatures ----
  y = Math.max(y, doc.internal.pageSize.getHeight() - 45) + 6;
  const sigW = (pageW - m * 2 - 16) / 3;
  ["Prepared By", "Delivered By (Driver)", "Received By"].forEach(
    (lab, i) => {
      const x = m + i * (sigW + 8);
      doc.setDrawColor(...PDF.ink);
      doc.setLineWidth(0.3);
      doc.line(x, y + 14, x + sigW, y + 14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(...PDF.muted);
      doc.text(lab, x, y + 18.5);
      doc.text("Name / Date / Company Stamp", x, y + 22, {});
    },
  );

  drawDocFooter(doc);
  doc.save(`DO-${order.doNo}.pdf`);
}
