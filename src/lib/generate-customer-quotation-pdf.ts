import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM, fmtDate, addHookkaLetterhead } from "@/lib/pdf-utils";

// Fixed seat-height set the sales team quotes against. Keep ordered
// so columns line up the same way across every quotation (matches the
// Products page SOFA tab header row: 24 / 28 / 30 / 32 / 35).
const SEAT_HEIGHTS = ["24", "28", "30", "32", "35"] as const;

export type QuotationCustomer = {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
};

// Extended shape so the PDF can mirror the Products page columns. The
// caller already has access to sizeCode/sizeLabel/unitM3/fabricUsage/
// productionTimeMinutes/baseModel via the global /api/products cache —
// customer_products' GET only coalesces price columns, so these extras
// must come from the products cache on the caller side.
export type QuotationProduct = {
  code: string;
  name: string;
  category: string;
  basePriceSen: number;
  price1Sen: number | null;
  seatHeightPrices: Array<{ height: string; priceSen: number }> | null;
  // Optional SKU-master fields (caller fills from the products cache when
  // the customer_products response omits them). Absent -> rendered as "—".
  sizeCode?: string | null;
  sizeLabel?: string | null;
  baseModel?: string | null;
  unitM3?: number | null;
  fabricUsage?: number | null;
  productionTimeMinutes?: number | null;
  // Bedframe-only per-SO customisation fields. They don't live on the
  // product master (only on sales_order_lines), so today they'll always
  // be null — kept here so the PDF shape matches the spec and so future
  // per-customer defaults can flow through without another signature bump.
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
};

export type QuotationArgs = {
  customer: QuotationCustomer;
  products: QuotationProduct[];
};

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------
const DASH = "\u2014"; // em dash — used consistently for "missing" cells

function minutesCell(min: number | null | undefined): string {
  if (!min || min <= 0) return DASH;
  return `${min} min`;
}

function unitM3Cell(m3: number | null | undefined): string {
  if (m3 == null || !isFinite(m3) || m3 <= 0) return DASH;
  return m3.toFixed(3);
}

function fabricCell(f: number | null | undefined): string {
  if (f == null || !isFinite(f) || f <= 0) return DASH;
  return `${f} m`;
}

function rmOrDash(sen: number | null | undefined): string {
  if (sen == null || sen <= 0) return DASH;
  return fmtRM(sen);
}

function seatPriceFor(
  sh: Array<{ height: string; priceSen: number }> | null | undefined,
  target: string,
): string {
  if (!sh || sh.length === 0) return DASH;
  // DB has stored heights as int 24, string "24", and '24"' at different
  // points — normalise both sides so a matching row always hits.
  const norm = (v: unknown) => String(v ?? "").replace('"', "").trim();
  const hit = sh.find((s) => norm(s.height) === target);
  if (!hit || hit.priceSen <= 0) return DASH;
  return fmtRM(hit.priceSen);
}

// Stable category order — matches how the sales team discusses the catalog.
const CATEGORY_ORDER = ["BEDFRAME", "SOFA", "ACCESSORY"] as const;
type CategoryKey = (typeof CATEGORY_ORDER)[number];

function groupByCategory(
  products: QuotationProduct[],
): Record<CategoryKey, QuotationProduct[]> {
  const buckets: Record<CategoryKey, QuotationProduct[]> = {
    BEDFRAME: [],
    SOFA: [],
    ACCESSORY: [],
  };
  for (const p of products) {
    const cat = (p.category || "").toUpperCase();
    if (cat === "BEDFRAME" || cat === "SOFA" || cat === "ACCESSORY") {
      buckets[cat as CategoryKey].push(p);
    }
  }
  return buckets;
}

export default function generateCustomerQuotationPdf(args: QuotationArgs): jsPDF {
  const { customer, products } = args;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const co = COMPANY.HOOKKA;
  const today = new Date().toISOString();

  // =========================================================================
  // 1. COMPANY HEADER (logo + legal text)
  // =========================================================================
  addHookkaLetterhead(doc, margin, 5, 10);
  const textX = margin + 26;

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(co.name, textX, 12);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Reg No: ${co.regNo}`, textX, 17);
  doc.text(co.address, textX, 22);
  doc.text(`Tel: ${co.phone}`, textX, 27);

  // =========================================================================
  // 2. QUOTATION TITLE (right side)
  // =========================================================================
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("QUOTATION", pageW - margin, 14, { align: "right" });

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(customer.name, pageW - margin, 22, { align: "right" });

  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  doc.text(fmtDate(today), pageW - margin, 28, { align: "right" });

  // Divider
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 32, pageW - margin, 32);

  let y = 40;
  doc.setTextColor(31, 29, 27);

  // =========================================================================
  // 3. BILL TO
  // =========================================================================
  const colLeft = margin;
  const boxW = pageW / 2 - 10;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BILL TO", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + boxW, y + 7);

  let yLeft = y + 10;
  const billToFields: [string, string][] = [
    ["Customer", customer.name || "-"],
    ["Address", customer.address || "-"],
    ["Phone", customer.phone || "-"],
    ["Email", customer.email || "-"],
  ];

  doc.setFontSize(8);
  for (const [label, value] of billToFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colLeft + 3, yLeft);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    const lines = doc.splitTextToSize(String(value), boxW - 40);
    doc.text(lines, colLeft + 30, yLeft);
    yLeft += lines.length * 4 + 1;
  }

  y = yLeft + 8;

  // =========================================================================
  // 4. PER-CATEGORY SECTIONS — each section mirrors its Products page tab.
  // =========================================================================
  const grouped = groupByCategory(products);

  // Shared autoTable styling so every section looks like a sibling of the
  // others (and of the invoice/quotation family).
  const sharedStyles = {
    fontSize: 7.5,
    cellPadding: 2,
    textColor: [31, 29, 27] as [number, number, number],
    lineColor: [226, 221, 216] as [number, number, number],
    lineWidth: 0.3,
    overflow: "linebreak" as const,
  };
  const sharedHeadStyles = {
    fillColor: [255, 255, 255] as [number, number, number],
    textColor: [0, 0, 0] as [number, number, number],
    fontSize: 8,
    fontStyle: "bold" as const,
    lineColor: [0, 0, 0] as [number, number, number],
    lineWidth: 0.3,
  };
  // Striped look — subtle grey on odd rows. autoTable fills white by default
  // so we add a light fill to the alternate row to mimic the Products table.
  const sharedAltRow = { fillColor: [249, 250, 251] as [number, number, number] };

  function sectionHeader(title: string, count: number) {
    if (y > pageH - 30) {
      doc.addPage();
      y = margin;
    }
    // Horizontal rule above the section title, then bold 11pt label.
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.4);
    doc.line(margin, y, pageW - margin, y);
    y += 6;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text(`${title}  (${count})`, margin, y);
    y += 3;
  }

  function advanceYAfterTable() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 10;
  }

  for (const cat of CATEGORY_ORDER) {
    const rows = grouped[cat];
    if (rows.length === 0) continue;

    if (cat === "BEDFRAME") {
      // BF columns mirror the Products page BEDFRAME tab exactly: size +
      // Price 2 / Price 1 + unitM3 / fabric / total min. Per-SO heights
      // (gap / divan / leg) live on sales_order_lines, not on products,
      // so they're not part of the master quotation shape.
      sectionHeader("BEDFRAME", rows.length);
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [[
          "Product Code",
          "Description",
          "Size",
          "Price 2",
          "Price 1",
          "Unit M3",
          "Fabric",
          "Total Min",
        ]],
        body: rows.map((p) => [
          p.code,
          p.name,
          p.sizeLabel || p.sizeCode || DASH,
          rmOrDash(p.basePriceSen),
          rmOrDash(p.price1Sen),
          unitM3Cell(p.unitM3),
          fabricCell(p.fabricUsage),
          minutesCell(p.productionTimeMinutes),
        ]),
        styles: sharedStyles,
        headStyles: sharedHeadStyles,
        alternateRowStyles: sharedAltRow,
        columnStyles: {
          0: { cellWidth: 26 },
          1: { cellWidth: "auto" },
          2: { cellWidth: 18 },
          3: { cellWidth: 22, halign: "right" },
          4: { cellWidth: 22, halign: "right" },
          5: { cellWidth: 16, halign: "right" },
          6: { cellWidth: 16, halign: "right" },
          7: { cellWidth: 20, halign: "right" },
        },
      });
      advanceYAfterTable();
    }

    if (cat === "SOFA") {
      // SOFA columns mirror the Products page SOFA tab 1:1, minus the
      // Variants button (it's a UI control, not printable).
      sectionHeader("SOFA", rows.length);
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [[
          "Product Code",
          "Description",
          "Model",
          '24"',
          '28"',
          '30"',
          '32"',
          '35"',
          "Unit M3",
          "Fabric",
          "Total Min",
        ]],
        body: rows.map((p) => [
          p.code,
          p.name,
          p.baseModel || DASH,
          ...SEAT_HEIGHTS.map((h) => seatPriceFor(p.seatHeightPrices, h)),
          unitM3Cell(p.unitM3),
          fabricCell(p.fabricUsage),
          minutesCell(p.productionTimeMinutes),
        ]),
        styles: sharedStyles,
        headStyles: sharedHeadStyles,
        alternateRowStyles: sharedAltRow,
        columnStyles: {
          0: { cellWidth: 20 },
          1: { cellWidth: 30 },
          2: { cellWidth: 16 },
          3: { cellWidth: 14, halign: "right" },
          4: { cellWidth: 14, halign: "right" },
          5: { cellWidth: 14, halign: "right" },
          6: { cellWidth: 14, halign: "right" },
          7: { cellWidth: 14, halign: "right" },
          8: { cellWidth: 12, halign: "right" },
          9: { cellWidth: 12, halign: "right" },
          10: { cellWidth: "auto", halign: "right" },
        },
      });
      advanceYAfterTable();
    }

    if (cat === "ACCESSORY") {
      // ACCESSORY columns mirror the new 5-column Products page ACCESSORY
      // tab — pillows don't carry size/price1/seat-height data.
      sectionHeader("ACCESSORY", rows.length);
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Product Code", "Description", "Base Price", "Unit M3", "Fabric"]],
        body: rows.map((p) => [
          p.code,
          p.name,
          rmOrDash(p.basePriceSen),
          unitM3Cell(p.unitM3),
          fabricCell(p.fabricUsage),
        ]),
        styles: sharedStyles,
        headStyles: sharedHeadStyles,
        alternateRowStyles: sharedAltRow,
        columnStyles: {
          0: { cellWidth: 24 },
          1: { cellWidth: "auto" },
          2: { cellWidth: 28, halign: "right" },
          3: { cellWidth: 22, halign: "right" },
          4: { cellWidth: 22, halign: "right" },
        },
      });
      advanceYAfterTable();
    }
  }

  // =========================================================================
  // 5. FOOTER NOTE
  // =========================================================================
  if (y > pageH - 20) {
    doc.addPage();
    y = margin;
  }
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Prices exported ${fmtDate(today)}. Subject to change on the next revision.`,
    margin,
    y,
  );

  // --- Page footers (all pages) ---
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const footerY = pageH - 10;
    doc.setDrawColor(226, 221, 216);
    doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(156, 163, 175);
    doc.text(
      `${co.name}  |  This is a computer-generated document. No signature is required.`,
      margin,
      footerY,
    );
    doc.text(
      `Page ${p} of ${totalPages}  |  Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
      pageW - margin,
      footerY,
      { align: "right" },
    );
  }

  return doc;
}
