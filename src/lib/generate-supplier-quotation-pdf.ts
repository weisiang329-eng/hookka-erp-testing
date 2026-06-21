import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import {
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  tableTheme,
  fmtDate,
} from "@/lib/pdf-utils";
import type { LetterheadCompany } from "@/lib/pdf-utils";

// ---------------------------------------------------------------------------
// Supplier Quotation / Price List PDF.
//
// The supplier-side analog of the customer quotation: a printable price list of
// everything a supplier quotes us — their SKU, our internal code, the current
// effective unit price + currency, MOQ, lead time and the date that price took
// effect (Effective From), pulled from supplier_material_bindings.
//
// Restyled 2026-06-21 to mirror the Customer Quotation layout: it shares the
// SAME premium design system as every other document (drawLetterhead /
// drawSectionLabel / tableTheme / drawDocFooter from pdf-utils) so all company
// PDFs look like siblings. Tune the look in pdf-utils → every doc follows.
// HOOKKA by default; a supplier's purchase_org_code flips the printed letterhead
// to OHANA (cosmetic only, like the PO/customer-quotation PDFs).
// ---------------------------------------------------------------------------
export type SupplierQuotationSupplier = {
  code: string;
  name: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  purchaseOrgCode?: string | null;
};

export type SupplierQuotationLine = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  supplierDescription?: string | null;
  unitPriceSen: number; // stored in sen (display = /100)
  currency: string; // MYR / RMB / …
  leadTimeDays: number;
  moq: number;
  // The date this price takes effect (effective-dated model). Replaces the old
  // priceValidTo column on the printed quotation.
  effectiveFrom?: string | null;
};

function fmtMoney(sen: number, currency: string): string {
  const v = (Number(sen) || 0) / 100;
  const n = v.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency && currency !== "MYR" ? `${n} ${currency}` : `RM ${n}`;
}

function resolveLetterhead(
  code: string | null | undefined,
): { code: "HOOKKA" | "OHANA"; info: LetterheadCompany } {
  const c = (code || "HOOKKA").toUpperCase();
  if (c === "OHANA") {
    return {
      code: "OHANA",
      info: {
        name: COMPANY.OHANA.name,
        regNo: COMPANY.OHANA.regNo ?? "",
        tin: COMPANY.OHANA.tin ?? "",
        address: COMPANY.OHANA.address ?? "",
        phone: COMPANY.OHANA.phone ?? "",
        email: COMPANY.OHANA.email ?? "",
      },
    };
  }
  return {
    code: "HOOKKA",
    info: {
      name: COMPANY.HOOKKA.name,
      regNo: COMPANY.HOOKKA.regNo ?? "",
      tin: COMPANY.HOOKKA.tin ?? "",
      address: COMPANY.HOOKKA.address ?? "",
      phone: COMPANY.HOOKKA.phone ?? "",
      email: COMPANY.HOOKKA.email ?? "",
    },
  };
}

export function generateSupplierQuotationPdf(
  supplier: SupplierQuotationSupplier,
  lines: SupplierQuotationLine[],
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  const co = resolveLetterhead(supplier.purchaseOrgCode);
  const isHookka = co.code === "HOOKKA";
  const today = new Date().toISOString();

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const margin = 14; // PDF.margin — matches the shared design system

  // =========================================================================
  // 1. HEADER — shared letterhead (single source of truth across all docs).
  //    Logo is skipped for sister companies so OHANA isn't mis-branded.
  // =========================================================================
  let y = drawLetterhead(doc, {
    docTitle: "SUPPLIER QUOTATION",
    docNo: `${supplier.code} - ${supplier.name}`,
    docDate: fmtDate(today),
    logo: isHookka,
    companyInfo: co.info,
  });
  doc.setTextColor(31, 29, 27);

  // =========================================================================
  // 2. SUPPLIER block — mirrors the customer quotation "BILL TO" section.
  // =========================================================================
  y = drawSectionLabel(doc, "Supplier", y + 2);

  const supplierFields: Array<[string, string]> = [
    ["Supplier", `${supplier.code} - ${supplier.name}`],
    ["Contact", supplier.contactPerson || "-"],
    ["Email", supplier.email || "-"],
    ["Phone", supplier.phone || "-"],
  ];
  doc.setFontSize(8);
  for (const [label, value] of supplierFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), margin + 28, y);
    y += 5;
  }
  y += 4;

  // =========================================================================
  // 3. QUOTED ITEMS — single section, mirroring the customer quotation tables
  //    (shared tableTheme: bronze header, hairline grid, striped rows).
  // =========================================================================
  y = drawSectionLabel(doc, `Quoted Items (${lines.length})`, y);

  const theme = tableTheme();
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [
      [
        "#",
        "Internal Code",
        "Supplier SKU",
        "Description",
        "MOQ",
        "Lead",
        "Unit Price",
        "Effective From",
      ],
    ],
    body: lines.map((l, i) => [
      String(i + 1),
      l.materialCode || "-",
      l.supplierSku || "-",
      l.supplierDescription?.trim() || l.materialName || "-",
      String(l.moq ?? 0),
      `${l.leadTimeDays ?? 0}d`,
      fmtMoney(l.unitPriceSen, l.currency),
      l.effectiveFrom ? fmtDate(l.effectiveFrom) : "-",
    ]),
    styles: theme.styles,
    headStyles: theme.headStyles,
    alternateRowStyles: theme.alternateRowStyles,
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: 24, fontStyle: "bold" },
      2: { cellWidth: 24 },
      3: { cellWidth: "auto" },
      4: { cellWidth: 14, halign: "right" },
      5: { cellWidth: 12, halign: "right" },
      6: { cellWidth: 26, halign: "right", fontStyle: "bold" },
      7: { cellWidth: 26, halign: "right" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  if (lines.length === 0) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(150, 150, 150);
    doc.text("No quoted items recorded for this supplier yet.", margin, y);
    y += 8;
  }

  // =========================================================================
  // 4. NOTE + FOOTER (shared footer on every page).
  // =========================================================================
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Prices exported ${fmtDate(today)}. Each price is effective from the date shown. Subject to change on the next revision.`,
    margin,
    y,
  );

  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawDocFooter(doc, co.code);
  }

  if (opts?.returnDoc) return doc;
  doc.save(`Quotation-${supplier.code.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}
