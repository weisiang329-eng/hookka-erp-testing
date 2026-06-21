import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { COMPANY } from "@/lib/constants";
import {
  drawLetterhead,
  fmtDate,
  PDF,
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
  address?: string | null;
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
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15; // mirrors the customer quotation margin

  // =========================================================================
  // 1. HEADER — shared letterhead (single source of truth across all docs).
  //    Logo is skipped for sister companies so OHANA isn't mis-branded.
  // =========================================================================
  let y = drawLetterhead(doc, {
    docTitle: "SUPPLIER QUOTATION",
    docNo: supplier.code,
    docDate: fmtDate(today),
    logo: isHookka,
    companyInfo: co.info,
  });
  doc.setTextColor(31, 29, 27);

  // =========================================================================
  // 2. SUPPLIER block — mirrors the customer quotation "BILL TO" section:
  //    bold label above a horizontal rule, then key–value rows at 8pt.
  // =========================================================================
  const boxW = pageW / 2 - 10;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPLIER", margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, margin + boxW, y + 7);

  let yLeft = y + 10;
  const supplierFields: Array<[string, string]> = [
    ["Supplier", `${supplier.code} - ${supplier.name}`],
    ["Address", supplier.address || "-"],
    ["Contact", supplier.contactPerson || "-"],
    ["Email", supplier.email || "-"],
    ["Phone", supplier.phone || "-"],
  ];
  doc.setFontSize(8);
  for (const [label, value] of supplierFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin + 3, yLeft);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    const lines2 = doc.splitTextToSize(String(value), boxW - 40);
    doc.text(lines2, margin + 30, yLeft);
    yLeft += lines2.length * 4 + 1;
  }
  y = yLeft + 8;

  // =========================================================================
  // 3. QUOTED ITEMS — section header mirrors customer quotation (horizontal
  //    rule + bold 11pt label above the table), table uses the same
  //    sharedStyles / sharedHeadStyles / sharedAltRow as the customer
  //    quotation (white header + black border, striped rows).
  // =========================================================================

  // Shared autoTable styling — mirrors the customer quotation exactly.
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
  const sharedAltRow = { fillColor: [249, 250, 251] as [number, number, number] };

  // Section header — same look as customer quotation's sectionHeader():
  // horizontal rule, then bold 11pt title with item count.
  if (y > pageH - 30) {
    doc.addPage();
    y = margin;
  }
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y);
  y += 6;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...PDF.accent);
  doc.text(`QUOTED ITEMS  (${lines.length})`, margin, y);
  y += 3;

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
    styles: sharedStyles,
    headStyles: sharedHeadStyles,
    alternateRowStyles: sharedAltRow,
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
  y = (doc as any).lastAutoTable.finalY + 10;

  if (lines.length === 0) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(150, 150, 150);
    doc.text("No quoted items recorded for this supplier yet.", margin, y);
    y += 8;
  }

  // =========================================================================
  // 4. FOOTER NOTE + PER-PAGE FOOTER — mirrors customer quotation footer:
  //    italic note line, then per-page hairline rule + company | Page X of Y
  //    | Generated date.
  // =========================================================================
  if (y > pageH - 20) {
    doc.addPage();
    y = margin;
  }
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Prices exported ${fmtDate(today)}. Each price is effective from the date shown. Subject to change on the next revision.`,
    margin,
    y,
  );

  // Per-page footer — same style as the customer quotation (NOT drawDocFooter,
  // which is the purchase-doc style; the quotation family uses faint rule +
  // company | page | generated).
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
      `${co.info.name}  |  This is a computer-generated document. No signature is required.`,
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

  if (opts?.returnDoc) return doc;
  doc.save(`Quotation-${supplier.code.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}
