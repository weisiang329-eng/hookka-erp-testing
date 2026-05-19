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
      itemCategory?: string | null; // SOFA / BEDFRAME / ACCESSORY
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
    }
  >;
};

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
    ["Deliver To", o.hubName || o.hubState || o.customerState || "-"],
    ["Address", order.deliveryAddress || "-"],
    ["Contact", order.contactPerson || "-"],
    ["Phone", order.contactPhone || "-"],
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

  // ---- Items, grouped by category ----
  // Wei Siang: when a DO mixes types, split into ordered sections —
  // BEDFRAME first, then SOFA, then the rest — each its own sub-table
  // numbered from 1 with its own subtotal, then one grand total. The
  // product code already carries the sofa variant, so a single
  // code+description+size+colour column set reads fine for both; any
  // bedframe-specific spec columns to be refined next round.
  y = drawSectionLabel(doc, "Items Delivered", y);

  type Row = DeliveryOrder["items"][number] & { salesOrderNo?: string };
  const catOf = (it: { id: string }): string => {
    const c = (extras?.items?.[it.id]?.itemCategory || "").toUpperCase();
    return c === "BEDFRAME" || c === "SOFA" || c === "ACCESSORY"
      ? c
      : "OTHER";
  };
  const CAT_ORDER = ["BEDFRAME", "SOFA", "ACCESSORY", "OTHER"] as const;
  const CAT_LABEL: Record<string, string> = {
    BEDFRAME: "Bedframe",
    SOFA: "Sofa",
    ACCESSORY: "Accessory",
    OTHER: "Other",
  };
  const groups = CAT_ORDER.map((cat) => ({
    cat,
    rows: order.items.filter((it) => catOf(it) === cat),
  })).filter((g) => g.rows.length > 0);

  const colStyles = {
    0: { cellWidth: 8, halign: "center" as const },
    1: { cellWidth: 26, overflow: "ellipsize" as const, fontStyle: "bold" as const },
    2: { cellWidth: "auto" as const, fontStyle: "bold" as const },
    3: { cellWidth: 22 },
    4: { cellWidth: 30, overflow: "ellipsize" as const },
    5: { cellWidth: 14, halign: "right" as const },
    6: { cellWidth: 18, halign: "right" as const },
  };
  let grandQty = 0;
  let grandM3 = 0;

  for (const g of groups) {
    if (groups.length > 1) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...PDF.accent);
      doc.text(CAT_LABEL[g.cat].toUpperCase(), m, y + 0.5);
      y += 3;
    }
    let gQty = 0;
    let gM3 = 0;
    const body = g.rows.map((it, idx) => {
      const itx = it as Row;
      const m3 =
        (Number((it as { itemM3?: number }).itemM3) || 0) * it.quantity;
      gQty += it.quantity;
      gM3 += m3;
      return [
        String(idx + 1),
        itx.salesOrderNo || "-",
        `${it.productCode}\n${it.productName}`,
        it.sizeLabel || "-",
        it.fabricCode || "-",
        String(it.quantity),
        m3.toFixed(2),
      ];
    });
    grandQty += gQty;
    grandM3 += gM3;
    autoTable(doc, {
      startY: y,
      margin: { left: m, right: m },
      head: [
        ["#", "SO No.", "Product Code / Description", "Size", "Colour / Fabric", "Qty", "M³"],
      ],
      body,
      foot: [
        groups.length > 1
          ? ["", "", "", "", `${CAT_LABEL[g.cat]} Subtotal`, String(gQty), gM3.toFixed(2)]
          : ["", "", "", "", "Total", String(gQty), gM3.toFixed(2)],
      ],
      ...tableTheme(),
      columnStyles: colStyles,
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
    y = (doc as any).lastAutoTable.finalY + (groups.length > 1 ? 5 : 7);
  }

  if (groups.length > 1) {
    doc.setDrawColor(...PDF.rule);
    doc.setLineWidth(0.3);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...PDF.ink);
    doc.text(
      `GRAND TOTAL   ·   Qty ${grandQty}   ·   M³ ${grandM3.toFixed(2)}`,
      pageW - m,
      y,
      { align: "right" },
    );
    y += 6;
  }

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
