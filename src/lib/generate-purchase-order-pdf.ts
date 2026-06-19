import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PurchaseOrder } from "@/lib/mock-data";
import { drawLetterhead } from "@/lib/pdf-utils";
import { COMPANY } from "@/lib/constants";

// Letterhead info passed in from the caller. Mirrors the COMPANY constant's
// shape so HOOKKA/OHANA fall through directly, and the route can populate
// the same fields from a registry row for dynamically-added sister
// companies (HOUZS, etc) without redeploying.
export type LetterheadInfo = {
  code: string;
  name: string;
  tagline?: string;
  phone?: string;
  email?: string;
  regNo?: string;
  tin?: string;
  address?: string;
  footerLine?: string;
};

function fmtCurrency(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

// Resolve the supplier's purchase_org_code into a LetterheadInfo. Falls
// back to HOOKKA so any pre-migration supplier (or unknown code) prints
// with the same letterhead they always had.
//
// Why this lives in the PDF module: the DB/AP entity is always HOOKKA;
// this is a cosmetic-only override on the printed page. Keeping the lookup
// table-free (vs. fetching /api/organisations in the PDF code) avoids a
// network round-trip during what is supposed to be an instant download.
// For sister companies beyond HOOKKA/OHANA the caller can pass a fully
// populated LetterheadInfo (looked up from /api/organisations elsewhere).
export function resolveLetterhead(code: string | undefined): LetterheadInfo {
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

// One org row from GET /api/organisations (the Settings → Organisations
// registry). Only the letterhead-relevant fields are needed here.
export type OrgRegistryRow = {
  code?: string | null;
  name?: string | null;
  regNo?: string | null;
  tin?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
};

// Resolve a Purchase Company code into its printed letterhead. Looks the code
// up in the organisations registry first (so ANY sister company — HOUZS etc. —
// prints its own name/reg/TIN/address, the owner's "借用 letterhead"), and
// falls back to the hardcoded HOOKKA/OHANA block when the registry isn't
// loaded or the code is unknown. The DB / accounting entity is ALWAYS HOOKKA;
// this only changes what prints on the page.
export function letterheadForPurchaseOrg(
  code: string | undefined,
  organisations?: OrgRegistryRow[],
): LetterheadInfo {
  const c = (code || "HOOKKA").toUpperCase();
  const org = organisations?.find((o) => (o.code || "").toUpperCase() === c);
  if (org && org.name) {
    return {
      code: c,
      name: org.name,
      regNo: org.regNo ?? "",
      tin: org.tin ?? "",
      address: org.address ?? "",
      phone: org.phone ?? "",
      email: org.email ?? "",
    };
  }
  return resolveLetterhead(code);
}

// PurchaseOrder shape returned by /api/purchase-orders includes a
// `purchaseOrgCode` field for letterhead override (migration 0142). Keep
// this typed loosely so we don't have to expand the canonical PurchaseOrder
// type just for the PDF caller.
export type PurchaseOrderWithLetterhead = PurchaseOrder & {
  purchaseOrgCode?: string;
};

export function generatePurchaseOrderPdf(
  po: PurchaseOrderWithLetterhead,
  letterheadOverride?: LetterheadInfo,
  // returnDoc: hand back the built jsPDF instead of saving — lets the bulk
  // "Download PDF" action merge several POs into one file (see merge-pdf.ts).
  opts?: { returnDoc?: boolean },
): jsPDF | void {
  // Letterhead override: HOOKKA by default; supplier.purchaseOrgCode flips
  // this to OHANA (or any registered sister company via letterheadOverride).
  // The actual buyer in the DB / accounting is always HOOKKA — this swap
  // only changes what prints on the page.
  const co = letterheadOverride ?? resolveLetterhead(po.purchaseOrgCode);
  const isHookkaLetterhead = co.code === "HOOKKA";

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 15;
  let y = margin;

  // --- Header (shared letterhead — single source of truth across all docs).
  // Logo is skipped for sister companies so we don't mis-brand OHANA/HOUZS. ---
  y = drawLetterhead(doc, {
    docTitle: "PURCHASE ORDER",
    docNo: po.poNo,
    docDate: fmtDate(po.orderDate),
    statusText: `Status: ${po.status.replace(/_/g, " ")}`,
    logo: isHookkaLetterhead,
    companyInfo: {
      name: co.name,
      regNo: co.regNo ?? "",
      tin: co.tin ?? "",
      address: co.address ?? "",
      phone: co.phone ?? "",
      email: co.email ?? "",
    },
  });
  doc.setTextColor(31, 29, 27);

  // --- Two-column: Supplier (left) + PO Details (right) ---
  const colLeft = margin;
  const colRight = pageW / 2 + 5;

  // Left column - Supplier Details
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("SUPPLIER DETAILS", colLeft + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colLeft, y + 7, colLeft + pageW / 2 - 10, y + 7);
  y += 10;

  const supplierFields = [
    ["Supplier", po.supplierName],
    ["Supplier ID", po.supplierId],
  ];

  doc.setFontSize(8);
  for (const [label, value] of supplierFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colLeft + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colLeft + 35, y);
    y += 5;
  }

  // Right column - PO Info
  let yRight = y;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("ORDER DETAILS", colRight + 3, yRight + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(colRight, yRight + 7, colRight + pageW / 2 - 10, yRight + 7);
  yRight += 10;

  const orderFields = [
    ["Order Date", fmtDate(po.orderDate)],
    ["Delivery Date", po.expectedDate ? fmtDate(po.expectedDate) : "-"],
    ["Payment Terms", "NET 30"],
    ["Status", po.status.replace(/_/g, " ")],
  ];

  doc.setFontSize(8);
  for (const [label, value] of orderFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, colRight + 3, yRight);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), colRight + 40, yRight);
    yRight += 5;
  }

  y = Math.max(y, yRight) + 8;

  // --- Items Table ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  const totalQty = po.items.reduce((s, i) => s + i.quantity, 0);
  doc.text(`ORDER ITEMS (${po.items.length} lines, ${totalQty} qty)`, margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const tableBody = po.items.map((item, idx) => [
    String(idx + 1),
    item.supplierSKU,
    item.materialName,
    item.unit,
    String(item.quantity),
    fmtCurrency(item.unitPriceSen),
    fmtCurrency(item.totalSen),
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["#", "Item Code", "Description", "Unit", "Qty", "Unit Price", "Total"]],
    body: tableBody,
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 8,
      fontStyle: "bold",
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
    alternateRowStyles: {
      fillColor: [255, 255, 255],
    },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 28, font: "helvetica", fontStyle: "bold" },
      2: { cellWidth: 50 },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 18, halign: "right" },
      5: { cellWidth: 28, halign: "right" },
      6: { cellWidth: 28, halign: "right", fontStyle: "bold" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 5;

  // --- Totals ---
  const totalsX = pageW - margin - 70;
  doc.setFontSize(8);

  // Subtotal
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("Subtotal:", totalsX, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(fmtCurrency(po.subtotalSen), pageW - margin, y, { align: "right" });
  y += 5;

  // Divider
  doc.setDrawColor(226, 221, 216);
  doc.line(totalsX, y - 2, pageW - margin, y - 2);

  // Grand Total
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("GRAND TOTAL:", totalsX, y + 2);
  doc.text(fmtCurrency(po.totalSen), pageW - margin, y + 2, { align: "right" });
  y += 12;

  // --- Notes ---
  if (po.notes) {
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, pageW - margin * 2, 15, "S");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("NOTES", margin + 3, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(po.notes, margin + 3, y + 9, { maxWidth: pageW - margin * 2 - 6 });
    y += 18;
  }

  // --- Terms & Conditions ---
  y += 3;
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(55, 65, 81);
  doc.text("TERMS & CONDITIONS", margin, y);
  y += 5;

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  // Buyer in the T&Cs is the letterhead company — that's how the supplier
  // reads it. Internally the buyer / AP entity is still HOOKKA INDUSTRIES;
  // the cosmetic swap is documented in src/api/routes/organisations.ts.
  const buyerShort = co.code === "HOOKKA"
    ? "Hookka Industries"
    : co.name.replace(/\s+SDN\s+BHD\.?$/i, "");
  const terms = [
    `1. Goods must be delivered to ${buyerShort} premises unless otherwise stated.`,
    "2. All goods must comply with specified quality standards and specifications.",
    `3. Supplier must notify ${buyerShort} of any delivery delays at least 48 hours in advance.`,
    "4. Payment will be processed upon receipt and acceptance of goods as per agreed payment terms.",
    `5. ${buyerShort} reserves the right to reject goods that do not meet quality requirements.`,
    `6. This Purchase Order is subject to the standard terms of ${co.name}.`,
  ];

  for (const term of terms) {
    if (y > pageH - 40) {
      doc.addPage();
      y = margin;
    }
    doc.text(term, margin, y, { maxWidth: pageW - margin * 2 });
    y += 4;
  }

  // --- Authorized Signature ---
  y += 10;
  if (y > pageH - 35) {
    doc.addPage();
    y = margin + 10;
  }

  doc.setDrawColor(31, 29, 27);
  doc.line(margin, y + 12, margin + 60, y + 12);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(55, 65, 81);
  doc.text("Authorized Signature", margin, y + 17);
  doc.setFontSize(7);
  doc.setTextColor(107, 114, 128);
  doc.text(co.name, margin, y + 21);

  // Date on right
  doc.line(pageW - margin - 60, y + 12, pageW - margin, y + 12);
  doc.setFontSize(8);
  doc.setTextColor(55, 65, 81);
  doc.text("Date", pageW - margin - 60, y + 17);

  // --- Footer ---
  const footerY = pageH - 15;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`${co.name}  |  This is a computer-generated document.`, margin, footerY);
  doc.text(`Generated: ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`, pageW - margin, footerY, { align: "right" });

  // Save
  if (opts?.returnDoc) return doc;
  doc.save(`${po.poNo}.pdf`);
}

// Merge several purchase orders into ONE downloadable PDF (Purchase Orders
// list → bulk "Download PDF"). Each PO renders with the SAME letterhead-aware
// layout as the single download, then merge-pdf stitches them into one file.
export async function generateCombinedPurchaseOrderPdf(
  items: { po: PurchaseOrderWithLetterhead; letterhead?: LetterheadInfo }[],
  filename = "PurchaseOrders.pdf",
): Promise<void> {
  if (items.length === 0) return;
  const docs = items
    .map(({ po, letterhead }) =>
      generatePurchaseOrderPdf(po, letterhead, { returnDoc: true }),
    )
    .filter((d): d is jsPDF => !!d);
  const { downloadMergedPdf } = await import("./merge-pdf");
  await downloadMergedPdf(docs, filename);
}
