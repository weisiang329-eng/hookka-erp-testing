// ============================================================
// Service Case Report PDF — the reporting twin of generate-so-pdf.ts.
// Owner: "幫 service case 製作一個 PDF 好像 SO 那樣…可以看到裏面的照片".
// One A4 report per case: details, issue (5W), embedded issue photos,
// affected products + damaged parts, root cause(s) + prevention, action log,
// and any spawned service orders. Built on the shared premium PDF design
// system (src/lib/pdf-utils.ts) so it matches every other Hookka document.
// ============================================================
import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import {
  drawLetterhead,
  drawSectionLabel,
  tableTheme,
  drawDocFooter,
  fmtDate,
  PDF,
} from "@/lib/pdf-utils";

// Root-cause category → human label (mirrors ROOT_CAUSE_LABELS on the case
// detail page; kept local so the PDF module has no page dependency).
const RC_LABELS: Record<string, string> = {
  PRODUCTION: "Production / workmanship",
  DESIGN: "Design / R&D",
  MATERIAL: "Material / supplier",
  PROCESS: "Process / SOP gap",
  CUSTOMER: "Customer (not our fault)",
  TRANSPORT: "Transport / 3PL",
  SALES: "Sales / order-taking error",
  PICKING: "Picking / packing error",
  OTHER: "Other",
};

export type ServiceCasePdfData = {
  caseNo: string;
  status: string;
  customerName: string;
  customerCode?: string | null;
  customerPhone?: string | null;
  sourceType: string;
  sourceNo?: string | null;
  externalRef?: string | null;
  category?: string | null;
  createdByName?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  issueDescription?: string | null;
  issuePhotos?: string[];
  affectedProducts?: Array<{
    code: string;
    name: string;
    qty?: number | null;
    components?: Array<{ label: string; qty: number }>;
  }>;
  rootCauses?: Array<{ category: string; details?: Record<string, unknown> }>;
  preventionAction?: string | null;
  preventionOwner?: string | null;
  actionLog?: Array<{ date: string; description: string; createdByName?: string }>;
  orders?: Array<{
    serviceOrderNo: string;
    mode?: string | null;
    status: string;
    isSv?: boolean;
  }>;
};

// Flatten a per-category root-cause details object into a one-line summary.
function rcDetails(d?: Record<string, unknown>): string {
  if (!d) return "-";
  const parts: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v != null && String(v).trim()) parts.push(`${label}: ${String(v).trim()}`);
  };
  push("Dept", d.departmentName ?? d.designDeptName);
  push("Worker", d.workerName);
  push("Supplier", d.supplierName);
  push("Material", d.rawMaterialCode);
  push("3PL", d.threePlCompany);
  push("SOP", d.sopName);
  push("Sales", d.salesPerson);
  push("DO", d.doNo);
  push("Driver", d.driverName);
  if (d.notes && String(d.notes).trim()) parts.push(String(d.notes).trim());
  if (d.suggestedFix && String(d.suggestedFix).trim())
    parts.push(`Fix: ${String(d.suggestedFix).trim()}`);
  return parts.length ? parts.join(" · ") : "-";
}

export function generateServiceCasePdf(data: ServiceCasePdfData): void {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  const m = PDF.margin;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const bottom = pageH - 18; // keep clear of the footer

  let y = drawLetterhead(doc, {
    docTitle: "Service Case Report",
    docNo: data.caseNo,
    docDate: fmtDate(data.createdAt),
    statusText: data.status,
  });

  const finalY = () =>
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? y;
  // Page-break guard — start a fresh page if `need` mm won't fit.
  const ensure = (need: number) => {
    if (y + need > bottom) {
      doc.addPage();
      y = 16;
    }
  };
  const paragraph = (text: string, size = 8.5) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...PDF.ink);
    const lines = doc.splitTextToSize(text, pageW - 2 * m) as string[];
    for (const ln of lines) {
      ensure(5);
      doc.text(ln, m, y);
      y += 4.4;
    }
  };

  // ── Case details ──────────────────────────────────────────────────────
  y = drawSectionLabel(doc, "Case Details", y);
  const info: Array<[string, string]> = [
    [
      "Customer",
      `${data.customerCode ? data.customerCode + " — " : ""}${data.customerName}${
        data.customerPhone ? " (" + data.customerPhone + ")" : ""
      }`,
    ],
    [
      "Source",
      data.sourceType === "EXTERNAL"
        ? `External${data.externalRef ? " (" + data.externalRef + ")" : ""}`
        : data.sourceNo || data.sourceType,
    ],
    ["Category", data.category || "-"],
    ["Status", data.status],
    [
      "Opened",
      `${fmtDate(data.createdAt)}${
        data.createdByName ? " by " + data.createdByName : ""
      }`,
    ],
    ...(data.closedAt ? ([["Closed", fmtDate(data.closedAt)]] as [string, string][]) : []),
  ];
  autoTable(doc, {
    startY: y,
    margin: { left: m, right: m },
    body: info.map(([k, v]) => [
      { content: k, styles: { fontStyle: "bold", cellWidth: 34, textColor: PDF.muted } },
      v,
    ]) as RowInput[],
    theme: "plain",
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.4, textColor: PDF.ink },
  });
  y = finalY() + 6;

  // ── Issue description (5W) ────────────────────────────────────────────
  if (data.issueDescription && data.issueDescription.trim()) {
    ensure(14);
    y = drawSectionLabel(doc, "Issue Description", y);
    paragraph(data.issueDescription.trim());
    y += 4;
  }

  // ── Photos ────────────────────────────────────────────────────────────
  const photos = (data.issuePhotos ?? []).filter(
    (p) => typeof p === "string" && p.startsWith("data:image"),
  );
  if (photos.length) {
    ensure(14);
    y = drawSectionLabel(doc, `Photos (${photos.length})`, y);
    const cols = 3;
    const gap = 4;
    const cellW = (pageW - 2 * m - gap * (cols - 1)) / cols;
    const cellH = cellW * 0.75; // 4:3 box
    let col = 0;
    for (const p of photos) {
      if (col === 0) ensure(cellH + gap);
      const x = m + col * (cellW + gap);
      try {
        const props = doc.getImageProperties(p);
        const fmt = (props.fileType || "JPEG").toUpperCase();
        // Contain within the cell, preserving aspect ratio + centring.
        const scale = Math.min(cellW / props.width, cellH / props.height);
        const w = props.width * scale;
        const h = props.height * scale;
        const ox = x + (cellW - w) / 2;
        const oy = y + (cellH - h) / 2;
        doc.setDrawColor(...PDF.rule);
        doc.setLineWidth(0.2);
        doc.rect(x, y, cellW, cellH);
        doc.addImage(p, fmt, ox, oy, w, h);
      } catch {
        // Unreadable data URI — draw an empty bordered placeholder.
        doc.setDrawColor(...PDF.rule);
        doc.setLineWidth(0.2);
        doc.rect(x, y, cellW, cellH);
      }
      col++;
      if (col >= cols) {
        col = 0;
        y += cellH + gap;
      }
    }
    if (col !== 0) y += cellH + gap;
    y += 2;
  }

  // ── Affected products ─────────────────────────────────────────────────
  if (data.affectedProducts && data.affectedProducts.length) {
    ensure(16);
    y = drawSectionLabel(doc, "Affected Products", y);
    autoTable(doc, {
      startY: y,
      margin: { left: m, right: m },
      head: [["Code", "Product", "Qty", "Damaged parts"]],
      body: data.affectedProducts.map((p) => [
        p.code,
        p.name,
        p.qty != null ? String(p.qty) : "-",
        p.components && p.components.length
          ? p.components
              .map((c) => `${c.label}${c.qty > 1 ? " ×" + c.qty : ""}`)
              .join(", ")
          : "All parts",
      ]) as RowInput[],
      ...tableTheme(),
      columnStyles: {
        0: { cellWidth: 28 },
        2: { cellWidth: 14, halign: "right" },
      },
    });
    y = finalY() + 6;
  }

  // ── Root cause(s) + prevention ────────────────────────────────────────
  if (
    (data.rootCauses && data.rootCauses.length) ||
    data.preventionAction ||
    data.preventionOwner
  ) {
    ensure(16);
    y = drawSectionLabel(doc, "Root Cause & Prevention", y);
    if (data.rootCauses && data.rootCauses.length) {
      autoTable(doc, {
        startY: y,
        margin: { left: m, right: m },
        head: [["#", "Category", "Details"]],
        body: data.rootCauses.map((rc, i) => [
          String(i + 1),
          RC_LABELS[rc.category] || rc.category || "-",
          rcDetails(rc.details),
        ]) as RowInput[],
        ...tableTheme(),
        columnStyles: {
          0: { cellWidth: 8, halign: "center" },
          1: { cellWidth: 44 },
        },
      });
      y = finalY() + 4;
    }
    if (data.preventionAction && data.preventionAction.trim())
      paragraph(`Prevention: ${data.preventionAction.trim()}`);
    if (data.preventionOwner && data.preventionOwner.trim())
      paragraph(`Owner: ${data.preventionOwner.trim()}`);
    y += 4;
  }

  // ── Action log ────────────────────────────────────────────────────────
  if (data.actionLog && data.actionLog.length) {
    ensure(16);
    y = drawSectionLabel(doc, "Action Log", y);
    autoTable(doc, {
      startY: y,
      margin: { left: m, right: m },
      head: [["Date", "Action", "By"]],
      body: data.actionLog.map((a) => [
        fmtDate(a.date),
        a.description || "-",
        a.createdByName || "-",
      ]) as RowInput[],
      ...tableTheme(),
      columnStyles: { 0: { cellWidth: 24 }, 2: { cellWidth: 30 } },
    });
    y = finalY() + 6;
  }

  // ── Spawned service orders ────────────────────────────────────────────
  if (data.orders && data.orders.length) {
    ensure(16);
    y = drawSectionLabel(doc, "Service Orders", y);
    autoTable(doc, {
      startY: y,
      margin: { left: m, right: m },
      head: [["SO No", "Mode", "Status"]],
      body: data.orders.map((o) => [
        o.serviceOrderNo,
        o.isSv ? "SV" : o.mode || "-",
        o.status,
      ]) as RowInput[],
      ...tableTheme(),
    });
    y = finalY() + 6;
  }

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    drawDocFooter(doc);
  }

  doc.save(`${data.caseNo || "service-case"}.pdf`);
}
