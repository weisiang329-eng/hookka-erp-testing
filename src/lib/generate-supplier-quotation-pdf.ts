import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { drawLetterhead } from "@/lib/pdf-utils";
import { COMPANY } from "@/lib/constants";
import type { LetterheadInfo } from "@/lib/generate-purchase-order-pdf";

// ---------------------------------------------------------------------------
// Supplier Quotation / Price List PDF.
//
// The supplier-side analog of the customer quotation: a printable price list
// of everything a supplier quotes us — their SKU, our internal code, the unit
// price + currency, MOQ, lead time and the price-validity window — pulled from
// supplier_material_bindings. Same letterhead-aware A4 layout family as the
// PO / PI docs (HOOKKA by default; a supplier's purchase_org_code flips the
// printed letterhead to OHANA — cosmetic only, like the PO PDF).
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
  priceValidFrom?: string | null;
  priceValidTo?: string | null;
};

function fmtMoney(sen: number, currency: string): string {
  const v = (Number(sen) || 0) / 100;
  const n = v.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency && currency !== "MYR" ? `${n} ${currency}` : `RM ${n}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

function resolveLetterhead(code: string | null | undefined): LetterheadInfo {
  const c = (code || "HOOKKA").toUpperCase();
  if (c === "OHANA") {
    return {
      code: "OHANA",
      name: COMPANY.OHANA.name,
      tagline: "B2B Trading & Distribution",
      phone: COMPANY.OHANA.phone,
      email: COMPANY.OHANA.email,
      regNo: COMPANY.OHANA.regNo,
      tin: COMPANY.OHANA.tin,
      address: COMPANY.OHANA.address,
    };
  }
  return {
    code: "HOOKKA",
    name: COMPANY.HOOKKA.name,
    tagline: "Manufacturer of Premium Upholstered Furniture",
    phone: COMPANY.HOOKKA.phone,
    email: COMPANY.HOOKKA.email,
    regNo: COMPANY.HOOKKA.regNo,
    tin: COMPANY.HOOKKA.tin,
    address: COMPANY.HOOKKA.address,
  };
}

export function generateSupplierQuotationPdf(
  supplier: SupplierQuotationSupplier,
  lines: SupplierQuotationLine[],
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  const co = resolveLetterhead(supplier.purchaseOrgCode);
  const isHookka = co.code === "HOOKKA";

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;

  // --- Header (shared letterhead — single source of truth across all docs).
  // Logo is skipped for sister companies so we don't mis-brand OHANA/HOUZS. ---
  let y = drawLetterhead(doc, {
    docTitle: "SUPPLIER QUOTATION",
    docNo: "",
    docDate: `Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
    logo: isHookka,
    companyInfo: {
      name: co.name,
      regNo: co.regNo ?? "",
      tin: co.tin ?? "",
      address: co.address ?? "",
      phone: co.phone ?? "",
      email: co.email ?? "",
    },
  });

  // --- Supplier block ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPLIER", margin + 3, y);
  y += 6;
  doc.setFontSize(8);
  const fields: Array<[string, string]> = [
    ["Supplier", `${supplier.code} - ${supplier.name}`],
    ["Contact", supplier.contactPerson || "-"],
    ["Email", supplier.email || "-"],
  ];
  for (const [label, value] of fields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), margin + 30, y);
    y += 5;
  }
  y += 4;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`QUOTED ITEMS (${lines.length})`, margin + 3, y);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 2, pageW - margin, y + 2);
  y += 6;

  const body = lines.map((l, i) => [
    String(i + 1),
    l.materialCode || "-",
    l.supplierSku || "-",
    l.supplierDescription?.trim() || l.materialName || "-",
    String(l.moq ?? 0),
    `${l.leadTimeDays ?? 0}d`,
    fmtMoney(l.unitPriceSen, l.currency),
    l.priceValidTo ? fmtDate(l.priceValidTo) : "-",
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Internal Code", "Supplier SKU", "Description", "MOQ", "Lead", "Unit Price", "Valid To"]],
    body,
    styles: { fontSize: 8, cellPadding: 2.2, textColor: [31, 29, 27], lineColor: [226, 221, 216], lineWidth: 0.3 },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 8,
      fontStyle: "bold",
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
    alternateRowStyles: { fillColor: [255, 255, 255] },
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: 24, fontStyle: "bold" },
      2: { cellWidth: 24 },
      3: { cellWidth: 46 },
      4: { cellWidth: 14, halign: "right" },
      5: { cellWidth: 12, halign: "right" },
      6: { cellWidth: 26, halign: "right", fontStyle: "bold" },
      7: { cellWidth: 22, halign: "right" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  if (lines.length === 0) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(150, 150, 150);
    doc.text("No quoted items recorded for this supplier yet.", margin + 3, y);
    y += 8;
  }

  // --- Footer ---
  const footerY = pageH - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${co.name}  |  Supplier price list — computer-generated.`, margin, footerY);
  doc.text("Prices subject to the stated validity window.", pageW - margin, footerY, { align: "right" });

  if (opts?.returnDoc) return doc;
  doc.save(`Quotation-${supplier.code.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}
