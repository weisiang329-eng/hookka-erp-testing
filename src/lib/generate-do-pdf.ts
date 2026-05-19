import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { DeliveryOrder } from "@/lib/mock-data";
import { COMPANY } from "@/lib/constants";
import { fmtDate } from "@/lib/pdf-utils";

// Read-only print-extras from GET /api/delivery-orders/:id/print-extras.
// All optional — the PDF still renders if not supplied.
export type DOPrintExtras = {
  customerSO?: string;
  customerRef?: string;
  items?: Record<
    string,
    {
      itemCategory?: string | null; // SOFA / BEDFRAME / ACCESSORY
      customerPOId?: string | null; // customer's PO no. for this line
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
    }
  >;
};

const INK: [number, number, number] = [20, 20, 20];
const RULE: [number, number, number] = [0, 0, 0];

type ItemExtra = {
  itemCategory?: string | null;
  customerPOId?: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  totalHeightInches: number | null;
};

// Build the stacked Description cell for one line, legacy DO style:
//   line 1  product code (variant is in the code)
//   line 2  product name
//   line 3  build spec — differs by category:
//             BEDFRAME : fabric / DIVAN x" + y" LEG / z"
//             SOFA     : seat size / colour / y" LEG / TH z"
//             ACCESSORY: size / colour (whatever it has)
//   line 4  (CUSTOMER-PO)
function describe(
  it: { productCode: string; productName: string; fabricCode: string; sizeLabel: string },
  ex: ItemExtra | undefined,
): string {
  const lines: string[] = [];
  if (it.productCode) lines.push(it.productCode);
  if (it.productName) lines.push(it.productName);
  const cat = (ex?.itemCategory || "").toUpperCase();
  const dim = (v?: number | null) =>
    v == null || Number(v) === 0 ? null : `${v}"`;
  const spec: string[] = [];
  if (cat === "BEDFRAME") {
    // Bedframe: fabric first, then the divan/leg build, then total height.
    if (it.fabricCode) spec.push(it.fabricCode);
    const dl: string[] = [];
    const dv = dim(ex?.divanHeightInches);
    const lg = dim(ex?.legHeightInches);
    if (dv) dl.push(`DIVAN ${dv}`);
    if (lg) dl.push(`${lg} LEG`);
    if (dl.length) spec.push(dl.join(" + "));
    const th = dim(ex?.totalHeightInches);
    if (th) spec.push(th);
  } else {
    // Sofa (and sofa accessories): show the full variant the customer
    // ordered — seat size, colour/fabric, leg height and total height —
    // NOT the bedframe divan/gap fields.
    if (it.sizeLabel) spec.push(it.sizeLabel);
    if (it.fabricCode) spec.push(it.fabricCode);
    const lg = dim(ex?.legHeightInches);
    if (lg) spec.push(`${lg} LEG`);
    const th = dim(ex?.totalHeightInches);
    if (th) spec.push(`TH ${th}`);
  }
  if (spec.length) lines.push(spec.join(" / "));
  if (ex?.customerPOId) lines.push(`(${ex.customerPOId})`);
  return lines.join("\n");
}

const uomOf = (cat?: string | null) =>
  (cat || "").toUpperCase() === "ACCESSORY" ? "UNIT" : "SET";

// Category print order: bedframes first (1..N), then the sofa block, then
// accessories (which always travel with the sofas). Original order is
// preserved within each group so a DO that's all one type is unchanged.
const catRank = (cat?: string | null): number => {
  const c = (cat || "").toUpperCase();
  if (c === "BEDFRAME") return 0;
  if (c === "SOFA") return 1;
  if (c === "ACCESSORY") return 2;
  return 3;
};

// ---------------------------------------------------------------------------
// Delivery Order PDF — formal "standard" layout. Item | Description | UOM |
// Qty. Letterhead + header block repeat on every page; rows flow on.
// ---------------------------------------------------------------------------
export function generateDOPdf(order: DeliveryOrder, extras?: DOPrintExtras) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const m = 14;
  const co = COMPANY.HOOKKA;
  const o = order as DeliveryOrder & {
    customerPOId?: string;
    hubName?: string;
    hubState?: string;
    customerState?: string;
  };
  const branch = o.hubName || o.hubState || o.customerState || "";
  const headerCustomerPO =
    o.customerPOId ||
    (extras?.items
      ? Array.from(
          new Set(
            Object.values(extras.items)
              .map((x) => x.customerPOId || "")
              .filter(Boolean),
          ),
        ).join(", ")
      : "") ||
    "";
  const docDate = fmtDate(order.deliveryDate);

  // ---- repeated per-page header; returns the Y the table body starts ----
  const HEADER_BOTTOM = 78;
  const drawHeader = (pageNo: number) => {
    // Company block — centered, formal
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(co.name, pageW / 2, 16, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(
      `(${co.regNo})   |   TIN ${co.tin}`,
      pageW / 2,
      21,
      { align: "center" },
    );
    doc.text(co.address, pageW / 2, 25.5, { align: "center" });
    doc.text(`Tel: ${co.phone}   |   ${co.email}`, pageW / 2, 30, {
      align: "center",
    });

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, 34, pageW - m, 34);

    // Title + DO No.
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("DELIVERY ORDER", pageW / 2, 42, { align: "center" });
    doc.setFontSize(11);
    doc.text(`No. : ${order.doNo}`, pageW - m, 42, { align: "right" });

    // Left — Bill / Deliver to
    let ly = 50;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.text(
      `${order.customerName}${branch ? ` (${branch})` : ""}`,
      m,
      ly,
    );
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    ly += 5;
    const addr = doc.splitTextToSize(
      order.deliveryAddress || "-",
      (pageW - m * 2) * 0.55,
    );
    doc.text(addr, m, ly);
    ly += addr.length * 4 + 3;
    doc.text(
      `Tel : ${order.contactPhone || "-"}${branch ? ` (${branch})` : ""}    Fax :`,
      m,
      ly,
    );

    // Right — refs
    const rx = pageW / 2 + 14;
    const rv = pageW - m;
    let ry = 50;
    const row = (k: string, v: string) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.text(k, rx, ry);
      doc.text(":", rx + 28, ry);
      doc.setFont("helvetica", "bold");
      doc.text(v || "-", rx + 31, ry);
      ry += 5.5;
    };
    row("Your P/O No.", headerCustomerPO);
    row("Customer SO", extras?.customerSO || "-");
    row("Customer Ref", extras?.customerRef || "-");
    row("Terms", "C.O.D.");
    row("Date", docDate);
    row("Page", `${pageNo} of {tp}`);
    void rv;

    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.5);
    doc.line(m, HEADER_BOTTOM - 2, pageW - m, HEADER_BOTTOM - 2);
  };

  const totalQty = order.items.reduce((s, i) => s + i.quantity, 0);
  // Sort by category so a mixed DO prints all bedframes first, then the
  // sofa block, then accessories — stable within each group.
  const sortedItems = order.items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        catRank(extras?.items?.[a.it.id]?.itemCategory) -
          catRank(extras?.items?.[b.it.id]?.itemCategory) || a.i - b.i,
    )
    .map((x) => x.it);
  const body = sortedItems.map((it, idx) => {
    const ex = extras?.items?.[it.id];
    return [
      String(idx + 1),
      describe(
        {
          productCode: it.productCode || "",
          productName: it.productName || "",
          fabricCode: it.fabricCode || "",
          sizeLabel: it.sizeLabel || "",
        },
        ex,
      ),
      uomOf(ex?.itemCategory),
      String(it.quantity),
    ];
  });

  autoTable(doc, {
    head: [["Item", "Description", "UOM", "Qty"]],
    body,
    foot: [["", "", "Total", String(totalQty)]],
    margin: { top: HEADER_BOTTOM, left: m, right: m, bottom: 18 },
    showHead: "everyPage",
    showFoot: "lastPage",
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: { top: 1, bottom: 1.5, left: 2, right: 2 },
      textColor: INK,
      lineColor: RULE,
      lineWidth: 0,
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 8.5,
      lineWidth: { top: 0, bottom: 0.4, left: 0, right: 0 },
      lineColor: RULE,
    },
    footStyles: {
      fontStyle: "bold",
      lineWidth: { top: 0.4, bottom: 0, left: 0, right: 0 },
      lineColor: RULE,
    },
    columnStyles: {
      0: { cellWidth: 13, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 22, halign: "center" },
      3: { cellWidth: 18, halign: "right" },
    },
    didParseCell: (data) => {
      // First (code) + last ((PO)) lines of the Description read bold.
      if (data.section === "body" && data.column.index === 1) {
        data.cell.styles.fontSize = 8.3;
      }
    },
    didDrawPage: (data) => {
      drawHeader(data.pageNumber);
    },
  });

  if (typeof (doc as unknown as { putTotalPages?: unknown }).putTotalPages === "function") {
    (doc as unknown as { putTotalPages: (t: string) => void }).putTotalPages(
      "{tp}",
    );
  }

  // Footer note on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = doc.internal.pageSize.getHeight() - 9;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.line(m, fy - 4, pageW - m, fy - 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `${co.name} · ${co.regNo} · Computer-generated delivery order.`,
      m,
      fy,
    );
    doc.text(
      `Received in good order — Name / Date / Stamp`,
      pageW - m,
      fy,
      { align: "right" },
    );
  }

  doc.save(`DO-${order.doNo}.pdf`);
}
