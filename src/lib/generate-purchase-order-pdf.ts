import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PurchaseOrder } from "@/lib/mock-data";
import {
  fmtCurrency,
  splitCodeName,
  fmtRM,
  fmtDate,
  drawLetterhead,
  drawSectionLabel,
  drawDocFooter,
  PDF,
} from "@/lib/pdf-utils";
import { COMPANY } from "@/lib/constants";
import { hasLetterheadDetails } from "./org-letterhead-row";

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
  // A row from a caller who lacks `organisations:read` carries id/code/name
  // only — the registry GET omits reg-no / TIN / address for them
  // (BUG-2026-08-13-100). Using it would print "Reg.  | TIN " on a purchase
  // document, which is the C16 shape: a field the projection dropped and a
  // consumer still read. `hasLetterheadDetails` is the single decision; see
  // src/lib/org-letterhead-row.ts.
  if (org && org.name && hasLetterheadDetails(org)) {
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

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  // Align to the DO/SI family margin (14mm) so PO / PI / GRN frame identically.
  const margin = PDF.margin; // 14
  const cw = pageW - margin * 2;

  // --- Header (shared letterhead — single source of truth across all docs).
  // Logo is skipped for sister companies so we don't mis-brand OHANA/HOUZS. ---
  drawLetterhead(doc, {
    docTitle: "PURCHASE ORDER",
    docNo: po.poNo,
    docDate: fmtDate(po.orderDate),
    statusText: po.status.replace(/_/g, " "),
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
  doc.setTextColor(...PDF.ink);

  // --- Reference block (DO/SI lblVal two-column style) ---
  // Label in muted 8pt normal, value in INK bold; left column ~55% of the
  // content width, right column starts at pageW/2 + 12. Identical to
  // generate-do-pdf / generate-invoice-pdf.
  const labelW = 24;
  const lblVal = (
    x: number,
    yy: number,
    k: string,
    v: string,
    maxW: number,
  ): number => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.muted);
    doc.text(k, x, yy);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    const lines = doc.splitTextToSize(v || "-", maxW);
    doc.text(lines, x + labelW, yy);
    return yy + Math.max(1, lines.length) * 4.3 + 0.8;
  };

  const leftX = margin;
  const leftMaxW = cw * 0.55 - labelW;
  let ly = 40;
  ly = lblVal(leftX, ly, "Supplier", po.supplierName, leftMaxW);

  const rightX = pageW / 2 + 12;
  const rightMaxW = pageW - margin - rightX - labelW;
  let ry = 40;
  ry = lblVal(rightX, ry, "PO No.", po.poNo || "-", rightMaxW);
  ry = lblVal(rightX, ry, "Order Date", fmtDate(po.orderDate), rightMaxW);
  ry = lblVal(rightX, ry, "Delivery Date", po.expectedDate ? fmtDate(po.expectedDate) : "-", rightMaxW);
  ry = lblVal(rightX, ry, "Terms", "Net 30", rightMaxW);
  lblVal(rightX, ry, "Status", po.status.replace(/_/g, " "), rightMaxW);

  let y = Math.max(ly, ry) + 2;

  // --- Items (bronze section label, DO/SI house style) ---
  const totalQty = po.items.reduce((s, i) => s + i.quantity, 0);
  y = drawSectionLabel(doc, `Order Items (${po.items.length} lines, ${totalQty} qty)`, y);

  const tableBody = po.items.map((item, idx) => {
    // Prefer the real materialCode field (new POs); fall back to splitting
    // the "CODE - DESCRIPTION" materialName for old rows (splitCodeName uses
    // supplierSKU as a secondary hint when the name has no separator).
    const { code, description } = splitCodeName(
      item.materialCode || item.supplierSKU,
      item.materialName,
    );
    return [
      String(idx + 1),
      code,
      item.supplierSKU || "-",
      description,
      item.unit,
      String(item.quantity),
      fmtCurrency(item.unitPriceSen),
      fmtCurrency(item.totalSen),
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 16 },
    head: [[
      { content: "#", styles: { halign: "center" } },
      { content: "Item Code" },
      { content: "Supplier SKU" },
      { content: "Description" },
      { content: "Unit", styles: { halign: "center" } },
      { content: "Qty", styles: { halign: "right" } },
      { content: "Unit Price (RM)", styles: { halign: "right" } },
      { content: "Total (RM)", styles: { halign: "right" } },
    ]],
    body: tableBody,
    // DO/SI house theme: plain grid, white header with a black underline rule,
    // hairline body lines, dashed per-row separators.
    theme: "plain",
    rowPageBreak: "avoid",
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: { top: 1.3, bottom: 1.8, left: 1.8, right: 1.8 },
      textColor: PDF.ink,
      lineColor: PDF.rule,
      lineWidth: 0,
      overflow: "linebreak",
      valign: "top",
    },
    headStyles: {
      fontStyle: "bold",
      fontSize: 8,
      lineWidth: { top: 0, bottom: 0.5, left: 0, right: 0 },
      lineColor: PDF.ink,
      valign: "middle",
    },
    columnStyles: {
      0: { cellWidth: 9, halign: "center" },
      1: { cellWidth: 24, fontStyle: "bold" },
      2: { cellWidth: 32 },
      3: { cellWidth: "auto" },
      4: { cellWidth: 15, halign: "center" },
      5: { cellWidth: 14, halign: "right" },
      6: { cellWidth: 26, halign: "right" },
      7: { cellWidth: 26, halign: "right", fontStyle: "bold" },
    },
    didDrawCell(data) {
      // Thin dashed separator under every item row (drawn once on the last
      // column) — the DO/SI per-row separator.
      if (data.section !== "body" || data.column.index !== 7) return;
      const yy = data.cell.y + data.cell.height;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.1);
      doc.setLineDashPattern([0.7, 0.7], 0);
      doc.line(margin, yy, pageW - margin, yy);
      doc.setLineDashPattern([], 0);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY;

  // --- Totals (DO/SI right-aligned label + value pairs) ---
  y += 8;
  if (y > pageH - 70) {
    doc.addPage();
    y = 36;
  }
  const valX = pageW - margin;
  const lblX = pageW - margin - 42;
  const sumLine = (label: string, value: string, bold: boolean, big = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(big ? 11 : 8.5);
    doc.setTextColor(...(bold ? PDF.ink : PDF.muted));
    doc.text(label, lblX, y, { align: "right" });
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...PDF.ink);
    doc.text(value, valX, y, { align: "right" });
    y += big ? 8 : 6;
  };

  sumLine("Subtotal", fmtRM(po.subtotalSen), false);
  // Rule clears the 11pt TOTAL cap height (matches the SO/Invoice spacing).
  y += 3;
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.4);
  doc.line(lblX - 2, y - 5.5, valX, y - 5.5);
  sumLine("TOTAL", fmtRM(po.totalSen), true, true);

  // --- Notes ---
  if (po.notes) {
    const noteLines = doc.splitTextToSize(po.notes, cw);
    const blockH = 6 + noteLines.length * 3.6;
    if (y + blockH > pageH - 38) {
      doc.addPage();
      y = 36;
    }
    y = drawSectionLabel(doc, "Notes", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.ink);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 3.6 + 6;
  }

  // --- Terms & Conditions ---
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
  const tcLineH = 3.6;
  const tcBlockH = 6 + terms.length * tcLineH;
  if (y + tcBlockH > pageH - 40) {
    doc.addPage();
    y = 36;
  }
  y = drawSectionLabel(doc, "Terms & Conditions", y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.6);
  doc.setTextColor(...PDF.muted);
  for (const term of terms) {
    const ln = doc.splitTextToSize(term, cw);
    doc.text(ln, margin, y);
    y += ln.length * tcLineH;
  }
  y += 6;

  // --- Signature strip: Prepared By / Checked By / Authorized Signature. ---
  if (y + 26 > pageH - 18) {
    doc.addPage();
    y = 36;
  }
  const cw2 = pageW - margin * 2;
  const sigW = (cw2 - 8) / 3;
  const sigPos = [margin, margin + sigW + 4, margin + (sigW + 4) * 2];
  const sigLabels = ["Prepared By", "Checked By", "Authorized Signature"];
  doc.setDrawColor(...PDF.rule);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 3; i++) {
    doc.line(sigPos[i], y + 14, sigPos[i] + sigW - 2, y + 14);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...PDF.ink);
    doc.text(sigLabels[i], sigPos[i], y + 19);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...PDF.faint);
    doc.text("Name / Date / Stamp", sigPos[i], y + 23.5);
  }

  // --- Footer (all pages — shared DO/SI footer) ---
  // HOOKKA prints via the shared drawDocFooter; sister-company letterheads
  // (OHANA/HOUZS) keep their OWN name in the footer line, drawn in the same
  // hairline style so the look stays identical.
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    if (isHookkaLetterhead) {
      drawDocFooter(doc, "HOOKKA");
    } else {
      const fy = pageH - 12;
      doc.setDrawColor(...PDF.rule);
      doc.setLineWidth(0.3);
      doc.line(margin, fy - 4, pageW - margin, fy - 4);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      doc.setTextColor(...PDF.faint);
      doc.text(
        `${co.name} · This is a computer-generated document; no signature required for system records.`,
        margin,
        fy,
      );
      doc.text(
        `Generated ${new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}`,
        pageW - margin,
        fy,
        { align: "right" },
      );
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...PDF.faint);
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 16, { align: "right" });
  }

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
