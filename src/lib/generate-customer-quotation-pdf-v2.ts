// ---------------------------------------------------------------------------
// generate-customer-quotation-pdf-v2.ts
//
// Date-aware customer quotation PDF. Driven by the envelope returned from
// GET /api/customer-quotation?customerId=&asOf=. Every price the PDF
// renders has already been resolved server-side as of the operator-picked
// asOf date — this generator is a pure mapper from envelope to pages.
//
// Sections:
//   1. Letterhead (logo + company block + Quotation title + dates)
//   2. Customer block
//   3. Customer Products (grouped by category)
//   4. Sofa Combos (per-shape table, with customer override label)
//   5. Customer Maintenance Config (Bedframe / Sofa / Common sub-blocks)
//   6. Footer (page numbers + "Prices effective on <asOf>")
//
// The legacy generate-customer-quotation-pdf.ts is intentionally untouched
// so any other callers (sales / SO export paths) keep working — this file
// is the new path the customers page calls.
// ---------------------------------------------------------------------------
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM, fmtDate, addHookkaLetterhead } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Envelope types — must match the GET /api/customer-quotation response.
// ---------------------------------------------------------------------------
export type QuotationCustomer = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
};

export type QuotationProductRow = {
  productId: string;
  code: string;
  name: string;
  category: string;
  sizeCode: string | null;
  sizeLabel: string | null;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: Array<{ height: string; priceSen: number; tier?: string }>;
};

export type QuotationSofaCombo = {
  id: string;
  baseModel: string;
  componentSizes: string[][];
  fabricTier: string;
  pricesByHeight: Record<string, number>;
  effectiveFrom: string;
  customerName: string | null;
};

export type QuotationMaintenanceBlob = {
  master: unknown;
  masterEffectiveFrom: string | null;
  customer: unknown;
  customerEffectiveFrom: string | null;
};

// kv_config('org-letterhead'): optional override for the company block. When
// absent we fall back to COMPANY.HOOKKA, which is what the legacy generator
// already uses. The shape is intentionally loose so future fields (logo URL,
// SST/GST no., etc.) can be added without forcing a frontend bump.
export type LetterheadConfig = {
  name?: string;
  addressLines?: string[];
  phone?: string;
  email?: string;
  ssmNo?: string;
  taxNo?: string;
} | null;

export type QuotationEnvelope = {
  customer: QuotationCustomer;
  asOf: string;
  products: QuotationProductRow[];
  sofaCombos: QuotationSofaCombo[];
  maintenanceConfig: QuotationMaintenanceBlob;
  letterhead?: LetterheadConfig;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DASH = "—";
const SEAT_HEIGHTS = ["24", "28", "30", "32", "35"] as const;
const TIERS_ORDER = ["PRICE_1", "PRICE_2", "PRICE_3"] as const;
const TIER_LABEL: Record<string, string> = {
  PRICE_1: "P1",
  PRICE_2: "P2",
  PRICE_3: "P3",
  ANY: "ANY",
};

function rmOrDash(sen: number | null | undefined): string {
  if (sen == null || sen <= 0) return DASH;
  return fmtRM(sen);
}

function nthTierForHeight(
  rows: QuotationProductRow["seatHeightPrices"],
  height: string,
  tier: string,
): number | null {
  if (!rows || rows.length === 0) return null;
  const norm = (v: unknown) => String(v ?? "").replace('"', "").trim();
  const hit = rows.find(
    (s) => norm(s.height) === height && (s.tier ?? "PRICE_2") === tier,
  );
  return hit?.priceSen ?? null;
}

function fmtComponentGroups(groups: string[][]): string {
  // Render OR-groups as "A / B" joined by " + " across groups.
  // Example: [["2A(LHF)","2A(RHF)"], ["L(LHF)","L(RHF)"]] -> "2A(LHF) / 2A(RHF) + L(LHF) / L(RHF)"
  return groups
    .map((g) => g.join(" / "))
    .join(" + ");
}

// Build a CategoryKey -> rows map preserving the order BEDFRAME / SOFA / ACCESSORY.
const CATEGORY_ORDER = ["BEDFRAME", "SOFA", "ACCESSORY"] as const;
type CategoryKey = (typeof CATEGORY_ORDER)[number];
function groupByCategory(
  products: QuotationProductRow[],
): Record<CategoryKey, QuotationProductRow[]> {
  const buckets: Record<CategoryKey, QuotationProductRow[]> = {
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

// ---------------------------------------------------------------------------
// Letterhead config defaults
// ---------------------------------------------------------------------------
function resolveLetterhead(cfg: LetterheadConfig): {
  name: string;
  addressLines: string[];
  phone: string;
  email: string;
  ssmNo: string;
  taxNo: string;
} {
  const co = COMPANY.HOOKKA;
  if (!cfg) {
    return {
      name: co.name,
      addressLines: [...co.addressLines],
      phone: co.phone,
      email: co.email,
      ssmNo: co.regNo,
      taxNo: co.tin,
    };
  }
  return {
    name: cfg.name || co.name,
    addressLines:
      Array.isArray(cfg.addressLines) && cfg.addressLines.length > 0
        ? cfg.addressLines
        : [...co.addressLines],
    phone: cfg.phone || co.phone,
    email: cfg.email || co.email,
    ssmNo: cfg.ssmNo || co.regNo,
    taxNo: cfg.taxNo || co.tin,
  };
}

// ---------------------------------------------------------------------------
// Maintenance blob renderers — pulls priced & string lists out of the JSON
// ---------------------------------------------------------------------------
type MaintPriced = { value: string; priceSen: number };

function asPricedList(v: unknown): MaintPriced[] {
  if (!Array.isArray(v)) return [];
  const out: MaintPriced[] = [];
  for (const row of v) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const r = row as Record<string, unknown>;
      const value = typeof r.value === "string" ? r.value : "";
      const priceSen = typeof r.priceSen === "number" ? r.priceSen : 0;
      if (value) out.push({ value, priceSen });
    } else if (typeof row === "string") {
      out.push({ value: row, priceSen: 0 });
    }
  }
  return out;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}

function fmtPricedList(rows: MaintPriced[]): string {
  if (rows.length === 0) return DASH;
  return rows
    .map((r) => (r.priceSen > 0 ? `${r.value} — ${fmtRM(r.priceSen)}` : r.value))
    .join(", ");
}

function fmtStringList(rows: string[]): string {
  if (rows.length === 0) return DASH;
  return rows.join(", ");
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
export default function generateCustomerQuotationPdfV2(
  env: QuotationEnvelope,
): jsPDF {
  const { customer, asOf, products, sofaCombos, maintenanceConfig } = env;
  const letterhead = resolveLetterhead(env.letterhead ?? null);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  const today = new Date().toISOString();

  // -------------------------------------------------------------------------
  // 1. LETTERHEAD (top of page 1; footer applied to every page later)
  // -------------------------------------------------------------------------
  // Logo: reuse the addHookkaLetterhead helper. If no kv_config override is
  // provided, this matches the legacy quotation look.
  try {
    addHookkaLetterhead(doc, margin, 5, 11);
  } catch {
    // Logo asset missing in some build modes — ignore so the PDF still renders.
  }
  const textX = margin + 28;

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text(letterhead.name, textX, 12);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  let lhY = 17;
  for (const line of letterhead.addressLines) {
    doc.text(line, textX, lhY);
    lhY += 3.5;
  }
  doc.text(`Tel: ${letterhead.phone}  |  Email: ${letterhead.email}`, textX, lhY);
  lhY += 3.5;
  doc.text(
    `SSM: ${letterhead.ssmNo}  |  TIN: ${letterhead.taxNo}`,
    textX,
    lhY,
  );

  // Right-aligned title + dates
  doc.setFontSize(20);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("QUOTATION", pageW - margin, 14, { align: "right" });

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`Effective: ${fmtDate(asOf)}`, pageW - margin, 21, {
    align: "right",
  });
  doc.text(`Generated: ${fmtDate(today)}`, pageW - margin, 25, {
    align: "right",
  });
  doc.text(`Customer: ${customer.code}`, pageW - margin, 29, {
    align: "right",
  });

  // Divider
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 35, pageW - margin, 35);

  let y = 42;
  doc.setTextColor(31, 29, 27);

  // -------------------------------------------------------------------------
  // 2. CUSTOMER BLOCK
  // -------------------------------------------------------------------------
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("BILL TO", margin, y);
  doc.setLineWidth(0.3);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 1.5, margin + 50, y + 1.5);
  y += 5;

  doc.setFontSize(8);
  const billRows: [string, string][] = [
    ["Customer", customer.name || DASH],
    ["Address", customer.address || DASH],
    ["Phone", customer.phone || DASH],
    ["Email", customer.email || DASH],
  ];
  for (const [label, value] of billRows) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    const lines = doc.splitTextToSize(String(value), pageW - margin * 2 - 30);
    doc.text(lines, margin + 25, y);
    y += lines.length * 4 + 1;
  }
  y += 4;

  // -------------------------------------------------------------------------
  // Shared autoTable styles
  // -------------------------------------------------------------------------
  const sharedStyles = {
    fontSize: 7.5,
    cellPadding: 1.8,
    textColor: [31, 29, 27] as [number, number, number],
    lineColor: [226, 221, 216] as [number, number, number],
    lineWidth: 0.3,
    overflow: "linebreak" as const,
  };
  const sharedHead = {
    fillColor: [243, 240, 235] as [number, number, number],
    textColor: [0, 0, 0] as [number, number, number],
    fontSize: 8,
    fontStyle: "bold" as const,
    lineColor: [180, 180, 180] as [number, number, number],
    lineWidth: 0.3,
  };
  const sharedAlt = { fillColor: [249, 250, 251] as [number, number, number] };

  function ensureRoom(needed: number) {
    if (y + needed > pageH - 18) {
      doc.addPage();
      y = margin;
    }
  }

  function sectionHeader(title: string, subtitle?: string) {
    ensureRoom(14);
    doc.setDrawColor(107, 92, 50);
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW - margin, y);
    y += 5;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(107, 92, 50);
    doc.text(title, margin, y);
    if (subtitle) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(120, 120, 120);
      doc.text(subtitle, pageW - margin, y, { align: "right" });
    }
    y += 4;
  }

  function advanceYAfterTable() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // -------------------------------------------------------------------------
  // 3. CUSTOMER PRODUCTS
  // -------------------------------------------------------------------------
  sectionHeader(
    `Customer Products (${products.length})`,
    `Prices as of ${fmtDate(asOf)}`,
  );

  if (products.length === 0) {
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(120, 120, 120);
    doc.text("No products assigned to this customer.", margin, y);
    y += 8;
  } else {
    const grouped = groupByCategory(products);

    for (const cat of CATEGORY_ORDER) {
      const rows = grouped[cat];
      if (rows.length === 0) continue;

      ensureRoom(20);
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(31, 29, 27);
      doc.text(`${cat}  (${rows.length})`, margin, y);
      y += 2;

      if (cat === "SOFA") {
        // Sofa: per-row main entry plus a tier sub-row per seat height.
        // The header line shows code/name/model/Price 2/Price 1; below it
        // a small tier matrix shows P1/P2/P3 across the standard heights.
        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin },
          head: [["Code", "Description", "Size", "Price 2", "Price 1"]],
          body: rows.map((p) => [
            p.code,
            p.name,
            p.sizeLabel || p.sizeCode || DASH,
            rmOrDash(p.basePriceSen),
            rmOrDash(p.price1Sen),
          ]),
          styles: sharedStyles,
          headStyles: sharedHead,
          alternateRowStyles: sharedAlt,
          columnStyles: {
            0: { cellWidth: 24 },
            1: { cellWidth: "auto" },
            2: { cellWidth: 22 },
            3: { cellWidth: 24, halign: "right" },
            4: { cellWidth: 24, halign: "right" },
          },
        });
        advanceYAfterTable();

        // Compact seat-height matrix per sofa SKU. Skip when no rows.
        const matrixHead: string[] = [
          "Code",
          "Tier",
          ...SEAT_HEIGHTS.map((h) => `${h}"`),
        ];
        const matrixBody: string[][] = [];
        for (const p of rows) {
          if (!p.seatHeightPrices || p.seatHeightPrices.length === 0) continue;
          for (const tier of TIERS_ORDER) {
            const row: string[] = [p.code, TIER_LABEL[tier] ?? tier];
            let any = false;
            for (const h of SEAT_HEIGHTS) {
              const sen = nthTierForHeight(p.seatHeightPrices, h, tier);
              if (sen != null && sen > 0) any = true;
              row.push(sen != null && sen > 0 ? fmtRM(sen) : DASH);
            }
            if (any) matrixBody.push(row);
          }
        }
        if (matrixBody.length > 0) {
          ensureRoom(15);
          doc.setFontSize(8);
          doc.setFont("helvetica", "italic");
          doc.setTextColor(107, 92, 50);
          doc.text("Seat-height tier matrix", margin, y);
          y += 2;
          autoTable(doc, {
            startY: y,
            margin: { left: margin, right: margin },
            head: [matrixHead],
            body: matrixBody,
            styles: sharedStyles,
            headStyles: sharedHead,
            alternateRowStyles: sharedAlt,
            columnStyles: {
              0: { cellWidth: 24 },
              1: { cellWidth: 14 },
              2: { halign: "right" },
              3: { halign: "right" },
              4: { halign: "right" },
              5: { halign: "right" },
              6: { halign: "right" },
            },
          });
          advanceYAfterTable();
        }
      } else if (cat === "BEDFRAME") {
        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin },
          head: [["Code", "Description", "Size", "Price 2", "Price 1"]],
          body: rows.map((p) => [
            p.code,
            p.name,
            p.sizeLabel || p.sizeCode || DASH,
            rmOrDash(p.basePriceSen),
            rmOrDash(p.price1Sen),
          ]),
          styles: sharedStyles,
          headStyles: sharedHead,
          alternateRowStyles: sharedAlt,
          columnStyles: {
            0: { cellWidth: 26 },
            1: { cellWidth: "auto" },
            2: { cellWidth: 22 },
            3: { cellWidth: 24, halign: "right" },
            4: { cellWidth: 24, halign: "right" },
          },
        });
        advanceYAfterTable();
      } else {
        // ACCESSORY
        autoTable(doc, {
          startY: y,
          margin: { left: margin, right: margin },
          head: [["Code", "Description", "Size", "Base Price"]],
          body: rows.map((p) => [
            p.code,
            p.name,
            p.sizeLabel || p.sizeCode || DASH,
            rmOrDash(p.basePriceSen),
          ]),
          styles: sharedStyles,
          headStyles: sharedHead,
          alternateRowStyles: sharedAlt,
          columnStyles: {
            0: { cellWidth: 26 },
            1: { cellWidth: "auto" },
            2: { cellWidth: 24 },
            3: { cellWidth: 28, halign: "right" },
          },
        });
        advanceYAfterTable();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. SOFA COMBOS
  // -------------------------------------------------------------------------
  sectionHeader(
    `Sofa Combos (${sofaCombos.length})`,
    `Customer-scoped overrides take precedence`,
  );

  if (sofaCombos.length === 0) {
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(120, 120, 120);
    doc.text("No combo rules apply on this date.", margin, y);
    y += 8;
  } else {
    // Heights actually present across all combos — sorted ascending.
    const heightsSet = new Set<string>();
    for (const c of sofaCombos) {
      for (const h of Object.keys(c.pricesByHeight)) heightsSet.add(h);
    }
    const heights = Array.from(heightsSet).sort(
      (a, b) => Number(a) - Number(b),
    );
    const head: string[] = [
      "Base",
      "Components",
      "Tier",
      "Scope",
      ...heights.map((h) => `${h}"`),
    ];
    const body: string[][] = sofaCombos.map((c) => {
      const row: string[] = [
        c.baseModel,
        fmtComponentGroups(c.componentSizes),
        TIER_LABEL[c.fabricTier] ?? c.fabricTier,
        c.customerName ? `Customer (${c.customerName})` : "Master",
      ];
      for (const h of heights) {
        const sen = c.pricesByHeight[h];
        row.push(typeof sen === "number" && sen > 0 ? fmtRM(sen) : DASH);
      }
      return row;
    });

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [head],
      body,
      styles: sharedStyles,
      headStyles: sharedHead,
      alternateRowStyles: sharedAlt,
      columnStyles: {
        0: { cellWidth: 16 },
        1: { cellWidth: "auto" },
        2: { cellWidth: 14 },
        3: { cellWidth: 28 },
      },
    });
    advanceYAfterTable();
  }

  // -------------------------------------------------------------------------
  // 5. MAINTENANCE CONFIG
  // -------------------------------------------------------------------------
  // Pick customer override when present, master otherwise. Surface the
  // effective-from of whichever was used so the operator can sanity-check.
  const usedBlob =
    maintenanceConfig.customer ?? maintenanceConfig.master ?? null;
  const usedFrom =
    maintenanceConfig.customer != null
      ? maintenanceConfig.customerEffectiveFrom
      : maintenanceConfig.masterEffectiveFrom;
  const usedScope =
    maintenanceConfig.customer != null ? "Customer override" : "Master";

  sectionHeader(
    "Customer Maintenance Config",
    usedFrom
      ? `${usedScope} — effective ${fmtDate(usedFrom)}`
      : `No config on this date`,
  );

  if (!usedBlob || typeof usedBlob !== "object") {
    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(120, 120, 120);
    doc.text("No maintenance config available.", margin, y);
    y += 8;
  } else {
    const b = usedBlob as Record<string, unknown>;
    const blocks: Array<{ section: string; entries: [string, string][] }> = [
      {
        section: "Bedframe",
        entries: [
          ["Divan Heights", fmtPricedList(asPricedList(b.divanHeights))],
          ["Total Heights", fmtPricedList(asPricedList(b.totalHeights))],
          ["Gaps", fmtStringList(asStringList(b.gaps))],
          ["Leg Heights", fmtPricedList(asPricedList(b.legHeights))],
          ["Specials", fmtPricedList(asPricedList(b.specials))],
        ],
      },
      {
        section: "Sofa",
        entries: [
          ["Sizes", fmtStringList(asStringList(b.sofaSizes))],
          ["Leg Heights", fmtPricedList(asPricedList(b.sofaLegHeights))],
          ["Specials", fmtPricedList(asPricedList(b.sofaSpecials))],
        ],
      },
      {
        section: "Common",
        entries: [["Fabrics", fmtStringList(asStringList(b.fabrics))]],
      },
    ];

    for (const block of blocks) {
      ensureRoom(20);
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(31, 29, 27);
      doc.text(block.section, margin, y);
      y += 2;
      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [["Field", "Values"]],
        body: block.entries,
        styles: sharedStyles,
        headStyles: sharedHead,
        alternateRowStyles: sharedAlt,
        columnStyles: {
          0: { cellWidth: 36 },
          1: { cellWidth: "auto" },
        },
      });
      advanceYAfterTable();
    }
  }

  // -------------------------------------------------------------------------
  // 6. FOOTER (every page)
  // -------------------------------------------------------------------------
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const footerY = pageH - 10;
    doc.setDrawColor(226, 221, 216);
    doc.setLineWidth(0.3);
    doc.line(margin, footerY - 4, pageW - margin, footerY - 4);
    doc.setFontSize(7);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(120, 120, 120);
    doc.text(
      `Prices effective on ${fmtDate(asOf)}. Generated ${fmtDate(today)}.`,
      margin,
      footerY,
    );
    doc.setFont("helvetica", "normal");
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, footerY, {
      align: "right",
    });
  }

  return doc;
}
