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
// This is the ONLY customer-quotation generator. The legacy
// generate-customer-quotation-pdf.ts was left in place when this file landed,
// on the assumption that "other callers (sales / SO export paths)" still used
// it — they did not; it had zero importers and was deleted in
// chore/dead-code-sweep.
// ---------------------------------------------------------------------------
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import { fmtRM, fmtDate, drawLetterhead } from "@/lib/pdf-utils";
import { sofaSeatHeights } from "./sofa-seat-heights";
import { getVariantsConfigSync } from "./kv-config";

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
// Follows Maintenance -> Sofa -> Sizes, read from the shared kv-config cache
// at render time. It used to be a five-entry literal missing 26", so a
// customer priced at 26" simply had no column on their quotation.
// Owner 2026-08-21. Not a hook: this runs outside React.
const SEAT_HEIGHTS = sofaSeatHeights(getVariantsConfigSync());
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

// (legacy helpers fmtPricedList / fmtStringList removed — the new
//  per-list mini-table layout doesn't need string formatting helpers)

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
  // 1. LETTERHEAD (top of page 1; also re-rendered before the SOFA section
  //    so Wei Siang can chop the bedframe pages and hand the SOFA pages out
  //    standalone with their own letterhead.)
  // -------------------------------------------------------------------------
  // Shared letterhead — single source of truth across all docs. Returns the
  // body-start Y so each call site continues from the same place. The asOf /
  // generated dates ride along as the right-side meta; the customer code is
  // the document number slot.
  function renderLetterhead(): number {
    return drawLetterhead(doc, {
      docTitle: "QUOTATION",
      docNo: `Customer: ${customer.code}`,
      docDate: `Effective: ${fmtDate(asOf)}`,
      statusText: `Generated: ${fmtDate(today)}`,
      logo: true,
      companyInfo: {
        name: letterhead.name,
        regNo: letterhead.ssmNo,
        tin: letterhead.taxNo,
        address: letterhead.addressLines.join(", "),
        phone: letterhead.phone,
        email: letterhead.email,
      },
    });
  }

  let y = renderLetterhead();
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

      // SOFA gets its own page with a fresh letterhead so the bedframe
      // pages can be detached and the SOFA pages handed out standalone.
      if (cat === "SOFA") {
        doc.addPage();
        y = renderLetterhead();
      }

      ensureRoom(20);
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(31, 29, 27);
      doc.text(`${cat}  (${rows.length})`, margin, y);
      y += 2;

      if (cat === "SOFA") {
        // Sofa: tier matrix grouped by base model (5531/5535/5539/...).
        // Per Wei Siang 2026-05-09: separate models with their own sub-table
        // so 40-row quotations stay readable. Also auto-hide seat-height
        // columns where every row in the model is dash (e.g. customers
        // restricted to 24/28/30 don't see empty 32"/35" columns).
        //
        // Base-model extraction: split on first "-" (e.g. "5531-1A(LHF)" →
        // "5531"). Falls back to the whole code if no dash.
        const sofaByModel = new Map<string, typeof rows>();
        for (const p of rows) {
          const model = p.code.split("-")[0] || p.code;
          if (!sofaByModel.has(model)) sofaByModel.set(model, []);
          sofaByModel.get(model)!.push(p);
        }
        const orderedModels = [...sofaByModel.keys()].sort();

        for (const model of orderedModels) {
          const rawRows = sofaByModel.get(model)!;

          // Merge LHF/RHF pairs whose seat_height_prices are identical into
          // a single virtual row labelled "X(LHF/RHF)" — Wei Siang 2026-05-09.
          // Pattern: code matches /^(\d+)-(.+)\((LHF|RHF)\)$/. Pair key is
          // (model, suffix-without-side, tier-array). When both sides exist
          // and price arrays match exactly, one merged row replaces the two.
          // Non-pair components and non-matching pairs pass through unchanged.
          const seatKey = (sh: typeof rawRows[number]["seatHeightPrices"]) =>
            (sh ?? [])
              .map((t) => `${String(t.height).replace('"', '').trim()}|${t.tier ?? "PRICE_2"}|${t.priceSen}`)
              .sort()
              .join(",");
          const sideRe = /^(.+)\((LHF|RHF)\)$/;
          const byKey = new Map<string, { lhf?: typeof rawRows[number]; rhf?: typeof rawRows[number] }>();
          const singletons: typeof rawRows = [];
          for (const p of rawRows) {
            const compPart = p.code.replace(/^\d+-/, "");
            const m = compPart.match(sideRe);
            if (!m) { singletons.push(p); continue; }
            const baseSuffix = m[1];
            const side = m[2] as "LHF" | "RHF";
            const key = `${baseSuffix}::${seatKey(p.seatHeightPrices)}`;
            if (!byKey.has(key)) byKey.set(key, {});
            byKey.get(key)![side === "LHF" ? "lhf" : "rhf"] = p;
          }
          const modelRows: typeof rawRows = [...singletons];
          for (const [key, pair] of byKey) {
            if (pair.lhf && pair.rhf) {
              const baseSuffix = key.split("::")[0];
              modelRows.push({
                ...pair.lhf,
                code: `${model}-${baseSuffix}(LHF/RHF)`,
                name: pair.lhf.name.replace(/\s*\(LHF\)\s*$/, "").trim() + " (LHF/RHF)",
              });
            } else {
              if (pair.lhf) modelRows.push(pair.lhf);
              if (pair.rhf) modelRows.push(pair.rhf);
            }
          }
          // Custom order per Wei Siang 2026-05-09: 1S, 2S, 3S, 1A, 2A, 1B,
          // 2B, 1NA, 2NA, L, CNR, STOOL. The (LHF/RHF) suffix is stripped
          // for ordering; merged pair rows already collapse both sides.
          const SUFFIX_ORDER = [
            "1S", "2S", "3S",
            "1A", "2A",
            "1B", "2B",
            "1NA", "2NA",
            "L", "CNR", "STOOL",
          ];
          const orderIdx = (code: string) => {
            const suffix = code.replace(/^\d+-/, "").replace(/\(LHF\/?RHF?\)$/, "");
            const i = SUFFIX_ORDER.indexOf(suffix);
            return i === -1 ? 999 : i;
          };
          modelRows.sort((a, b) => {
            const ai = orderIdx(a.code);
            const bi = orderIdx(b.code);
            if (ai !== bi) return ai - bi;
            return a.code.localeCompare(b.code);
          });

          // Build matrix body (all 5 heights), then drop empty columns.
          // Wei Siang 2026-05-09: Code column dropped — Description already
          // contains the same info ("SOFA 5531 1A (LHF/RHF)" carries the
          // model + suffix). Indices 0/1 are Description/Tier; 2..6 are seat
          // heights.
          const fullBody: string[][] = [];
          for (const p of modelRows) {
            if (!p.seatHeightPrices || p.seatHeightPrices.length === 0) continue;
            for (const tier of TIERS_ORDER) {
              const row: string[] = [p.name, TIER_LABEL[tier] ?? tier];
              let any = false;
              for (const h of SEAT_HEIGHTS) {
                const sen = nthTierForHeight(p.seatHeightPrices, h, tier);
                if (sen != null && sen > 0) any = true;
                row.push(sen != null && sen > 0 ? fmtRM(sen) : DASH);
              }
              if (any) fullBody.push(row);
            }
          }
          if (fullBody.length === 0) continue;

          // Drop seat-height columns whose every body cell is DASH. Indices
          // 0/1 are Description/Tier — always kept.
          const heightColUsed = SEAT_HEIGHTS.map((_, i) => {
            const colIdx = 2 + i;
            return fullBody.some((r) => r[colIdx] !== DASH);
          });
          const visibleHeights = SEAT_HEIGHTS.filter((_, i) => heightColUsed[i]);
          const matrixBody = fullBody.map((r) => [
            r[0], r[1],
            ...SEAT_HEIGHTS.map((_, i) => r[2 + i]).filter((_, i) => heightColUsed[i]),
          ]);
          const matrixHead = [
            "Description", "Tier",
            ...visibleHeights.map((h) => `${h}"`),
          ];

          // Sub-header for this model + a small gap before the table.
          ensureRoom(14);
          y += 1.5;
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.setTextColor(80, 80, 80);
          doc.text(`${model}  (${modelRows.length})`, margin, y);
          y += 1.5;

          autoTable(doc, {
            startY: y,
            margin: { left: margin, right: margin },
            head: [matrixHead],
            body: matrixBody,
            styles: sharedStyles,
            headStyles: sharedHead,
            alternateRowStyles: sharedAlt,
            columnStyles: {
              0: { cellWidth: "auto" }, // Description
              1: { cellWidth: 14 },     // Tier
              2: { halign: "right" },   // seat heights
              3: { halign: "right" },
              4: { halign: "right" },
              5: { halign: "right" },
              6: { halign: "right" },
            },
          });
          advanceYAfterTable();
          // Extra gap between model sub-tables for visual separation.
          y += 2;
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
    // Group combos by baseModel (Wei Siang 2026-05-09 — same treatment as
    // the SOFA SKU section). Each model gets its own sub-header + sub-table
    // with only the heights that group actually uses (auto-hide empties).
    const byModel = new Map<string, typeof sofaCombos>();
    for (const c of sofaCombos) {
      if (!byModel.has(c.baseModel)) byModel.set(c.baseModel, []);
      byModel.get(c.baseModel)!.push(c);
    }
    const orderedModels = [...byModel.keys()].sort();

    for (const model of orderedModels) {
      const modelCombos = byModel.get(model)!;
      // Sort combos cheap → expensive within the model (Wei Siang 2026-05-09).
      // Use the lowest seat-height price as the sort key — falls back to
      // any present price when 24" is absent. Empty/0 prices treated as
      // Infinity so they sort last.
      const cheapestPrice = (c: typeof modelCombos[number]) => {
        const vals = Object.values(c.pricesByHeight)
          .filter((v): v is number => typeof v === "number" && v > 0);
        return vals.length === 0 ? Infinity : Math.min(...vals);
      };
      modelCombos.sort((a, b) => cheapestPrice(a) - cheapestPrice(b));
      // Heights actually present across THIS model's combos.
      const heightsSet = new Set<string>();
      for (const c of modelCombos) {
        for (const [h, v] of Object.entries(c.pricesByHeight)) {
          if (typeof v === "number" && v > 0) heightsSet.add(h);
        }
      }
      const heights = Array.from(heightsSet).sort((a, b) => Number(a) - Number(b));
      if (heights.length === 0) continue;

      const head: string[] = [
        "Components",
        "Tier",
        "Scope",
        ...heights.map((h) => `${h}"`),
      ];
      const body: string[][] = modelCombos.map((c) => {
        const row: string[] = [
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

      ensureRoom(14);
      y += 1.5;
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(80, 80, 80);
      doc.text(`${model}  (${modelCombos.length})`, margin, y);
      y += 1.5;

      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin },
        head: [head],
        body,
        styles: sharedStyles,
        headStyles: sharedHead,
        alternateRowStyles: sharedAlt,
        columnStyles: {
          0: { cellWidth: "auto" }, // Components
          1: { cellWidth: 14 },     // Tier
          2: { cellWidth: 28 },     // Scope
          3: { halign: "right" },   // heights
          4: { halign: "right" },
          5: { halign: "right" },
          6: { halign: "right" },
          7: { halign: "right" },
        },
      });
      advanceYAfterTable();
      y += 2; // gap between model sub-tables
    }
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

  // Customer Maintenance Config gets its own page with a fresh letterhead
  // so the bedframe / sofa / config portions can each be detached and handed
  // out standalone. — Wei Siang 2026-05-09
  doc.addPage();
  y = renderLetterhead();

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

    // Render each list as its OWN small table so the operator can scan
    // values + surcharges line-by-line. Priced lists get an Item +
    // Surcharge two-column table. String lists (Gaps / Sizes / Fabrics)
    // get a compact comma-joined inline row labelled by the field name.
    type Block = {
      title: string;
      pricedLists: Array<{ label: string; rows: MaintPriced[] }>;
      stringLists: Array<{ label: string; rows: string[] }>;
    };
    const blocks: Block[] = [
      {
        title: "Bedframe",
        pricedLists: [
          { label: "Divan Heights", rows: asPricedList(b.divanHeights) },
          { label: "Total Heights", rows: asPricedList(b.totalHeights) },
          { label: "Leg Heights",   rows: asPricedList(b.legHeights) },
          { label: "Specials",      rows: asPricedList(b.specials) },
        ],
        stringLists: [
          { label: "Gaps", rows: asStringList(b.gaps) },
        ],
      },
      {
        title: "Sofa",
        pricedLists: [
          { label: "Leg Heights", rows: asPricedList(b.sofaLegHeights) },
          { label: "Specials",    rows: asPricedList(b.sofaSpecials) },
        ],
        stringLists: [
          { label: "Sizes", rows: asStringList(b.sofaSizes) },
        ],
      },
      {
        title: "Common",
        pricedLists: [],
        stringLists: [
          { label: "Fabrics", rows: asStringList(b.fabrics) },
        ],
      },
    ];

    for (const block of blocks) {
      ensureRoom(15);
      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(107, 92, 50);
      doc.text(block.title, margin, y);
      y += 4;

      // Priced lists — Item / Surcharge two-column mini-tables, one per list.
      for (const pl of block.pricedLists) {
        if (pl.rows.length === 0) continue;
        ensureRoom(15);
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(75, 85, 99);
        doc.text(pl.label, margin + 2, y);
        y += 1;
        autoTable(doc, {
          startY: y,
          margin: { left: margin + 2, right: margin },
          head: [["Item", "Surcharge"]],
          body: pl.rows.map((r) => [
            r.value,
            r.priceSen > 0 ? fmtRM(r.priceSen) : DASH,
          ]),
          styles: { ...sharedStyles, fontSize: 7.5 },
          headStyles: sharedHead,
          alternateRowStyles: sharedAlt,
          columnStyles: {
            0: { cellWidth: 50 },
            1: { cellWidth: 30, halign: "right" },
          },
          tableWidth: 80,
        });
        advanceYAfterTable();
      }

      // String lists — inline comma-joined under their label.
      for (const sl of block.stringLists) {
        if (sl.rows.length === 0) continue;
        ensureRoom(8);
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(75, 85, 99);
        doc.text(`${sl.label}:`, margin + 2, y);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(31, 29, 27);
        const labelWidth = doc.getTextWidth(`${sl.label}: `);
        const text = sl.rows.join(", ");
        // wrap if needed
        const usableWidth = pageW - margin * 2 - 4 - labelWidth;
        const wrapped = doc.splitTextToSize(text, usableWidth);
        doc.text(wrapped, margin + 2 + labelWidth + 1, y);
        y += 4 + (wrapped.length - 1) * 3.5;
      }

      y += 3;
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
