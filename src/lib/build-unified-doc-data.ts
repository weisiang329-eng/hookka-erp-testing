// ---------------------------------------------------------------------------
// build-unified-doc-data.ts — turns a normalized DO / Invoice input into the
// UnifiedDocData that buildUnifiedDocPdf renders. Workers-pure (no jsPDF). Both
// callers map their own shape into these normalized inputs, so the browser
// download and the backend auto-email produce byte-for-byte the same document.
// The row/grouping/ref logic mirrors renderDoInto in generate-do-pdf.ts.
// ---------------------------------------------------------------------------
import { catRank, catLabel, fmtPieces, buildSpec, uomOf, type BuildSpecExtra } from "./doc-line-format";
import type { UnifiedDocData, UnifiedDocGroup } from "../api/lib/unified-do-invoice-pdf";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// ISO / yyyy-mm-dd → "02 Jul 2026" (matches the documents' fmtDate). Pass an
// already-formatted string through unchanged.
export function fmtDocDate(v: string | null | undefined): string {
  if (!v) return "-";
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (isNaN(d.getTime())) return s;
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export type DocLineExtra = BuildSpecExtra & {
  pieces?: string | null;
  customerPOId?: string | null;
  salesOrderNo?: string | null;
  customerSO?: string | null;
  customerRef?: string | null;
  repairNote?: string | null;
};

export interface UnifiedDoInput {
  doNo: string;
  docDate: string; // ISO or pre-formatted
  statusText?: string;
  customerName: string;
  deliverTo?: string;
  deliveryAddress?: string;
  contactName?: string;
  contactPhone?: string;
  driverName?: string;
  driverPhone?: string;
  lorryPlate?: string;
  fallbackCustomerSO?: string;
  fallbackCustomerRef?: string;
  items: Array<{
    id: string;
    productCode: string;
    productName: string;
    fabricCode?: string;
    sizeLabel?: string;
    quantity: number;
    extra?: DocLineExtra;
  }>;
}

const rankPiece = (lab: string): number => {
  const u = lab.toUpperCase();
  return u === "HB" ? 0 : u === "DIVAN" ? 1 : u === "SOFA" ? 2 : 3;
};

export function buildUnifiedDoData(input: UnifiedDoInput, logoPngBase64?: string): UnifiedDocData {
  const ordered = input.items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const cr = catRank(a.it.extra?.itemCategory) - catRank(b.it.extra?.itemCategory);
      return cr !== 0 ? cr : a.i - b.i;
    })
    .map((x) => x.it);

  const groups: UnifiedDocGroup[] = [];
  let cur: UnifiedDocGroup | null = null;
  let totalSets = 0;
  let totalItems = 0;
  const grand = new Map<string, number>();
  const grandSeen = new Map<string, number>();

  for (const it of ordered) {
    const ex = it.extra;
    const catL = catLabel(ex?.itemCategory);
    if (!cur || cur.category !== catL) {
      cur = { category: catL, items: [] };
      groups.push(cur);
    }
    const fp = fmtPieces(ex?.pieces);
    const totQty = fp.total || it.quantity;
    totalSets += it.quantity;
    totalItems += totQty;
    if (ex?.pieces) {
      for (const part of String(ex.pieces).split(" + ")) {
        const mm = part.trim().match(/^(\d+)\s+(.+)$/);
        if (!mm) continue;
        const lab = mm[2].trim();
        if (!grandSeen.has(lab)) grandSeen.set(lab, grandSeen.size);
        grand.set(lab, (grand.get(lab) || 0) + Number(mm[1]));
      }
    }
    const ourSO = (ex?.salesOrderNo && String(ex.salesOrderNo).trim()) || "";
    const custPO = (ex?.customerPOId && String(ex.customerPOId).trim()) || "";
    const custSO =
      (ex?.customerSO && String(ex.customerSO).trim()) || (input.fallbackCustomerSO || "");
    const custRef =
      (ex?.customerRef && String(ex.customerRef).trim()) || (input.fallbackCustomerRef || "");
    const spec = buildSpec({ fabricCode: it.fabricCode || "", sizeLabel: it.sizeLabel || "" }, ex);
    cur.items.push({
      orderRefs: [`Our SO: ${ourSO || "-"}`, `PO: ${custPO || "-"}`, `SO: ${custSO || "-"}`, `REF: ${custRef || "-"}`],
      code: it.productCode || "",
      name: it.productName || "",
      specLines: [spec, ex?.repairNote || ""].filter(Boolean),
      set: it.quantity,
      qtyBreakdown: fp.text || uomOf(ex?.itemCategory),
      totalQty: totQty,
    });
  }

  const grandBreakdown =
    Array.from(grand.keys())
      .sort((a, b) => rankPiece(a) - rankPiece(b) || (grandSeen.get(a) ?? 0) - (grandSeen.get(b) ?? 0))
      .map((lab) => `${grand.get(lab)} ${lab}`)
      .join("  +  ") || "";

  const driverLine = `${input.driverName || "-"}${input.driverPhone ? ` (${input.driverPhone})` : ""}`;

  return {
    kind: "DO",
    docNo: input.doNo,
    docDate: fmtDocDate(input.docDate),
    statusText: input.statusText || "C.O.D.",
    leftFields: [
      ["Customer", input.customerName || "-"],
      ["Deliver To", input.deliverTo || "-"],
      ["Address", input.deliveryAddress || "-"],
      ["Contact", `${input.contactName || "-"}${input.contactPhone ? ` (${input.contactPhone})` : ""}`],
    ],
    rightFields: [
      ["DO No.", input.doNo],
      ["Date", fmtDocDate(input.docDate)],
      ["Driver", driverLine],
      ["Lorry Plate", input.lorryPlate || "-"],
    ],
    groups,
    totalSets,
    totalItems,
    grandBreakdown,
    logoPngBase64,
  };
}

export interface UnifiedInvoiceInput {
  invoiceNo: string;
  doNo?: string;
  docDate: string;
  dueDate?: string;
  terms?: string;
  customerName: string;
  billAddress?: string;
  contactName?: string;
  contactPhone?: string;
  fallbackCustomerSO?: string;
  fallbackCustomerRef?: string;
  items: Array<{
    id: string;
    productCode: string;
    productName: string;
    fabricCode?: string;
    sizeLabel?: string;
    quantity: number;
    priceSen: number;
    lineTotalSen: number;
    extra?: DocLineExtra;
  }>;
  subtotalSen: number;
  taxSen?: number;
  totalSen: number;
  amountInWords?: string;
}

export function buildUnifiedInvoiceData(input: UnifiedInvoiceInput, logoPngBase64?: string): UnifiedDocData {
  const ordered = input.items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const cr = catRank(a.it.extra?.itemCategory) - catRank(b.it.extra?.itemCategory);
      return cr !== 0 ? cr : a.i - b.i;
    })
    .map((x) => x.it);

  const groups: UnifiedDocGroup[] = [];
  let cur: UnifiedDocGroup | null = null;
  let totalSets = 0;

  for (const it of ordered) {
    const ex = it.extra;
    const catL = catLabel(ex?.itemCategory);
    if (!cur || cur.category !== catL) {
      cur = { category: catL, items: [] };
      groups.push(cur);
    }
    totalSets += it.quantity;
    const ourSO = (ex?.salesOrderNo && String(ex.salesOrderNo).trim()) || "";
    const custPO = (ex?.customerPOId && String(ex.customerPOId).trim()) || "";
    const custSO =
      (ex?.customerSO && String(ex.customerSO).trim()) || (input.fallbackCustomerSO || "");
    const custRef =
      (ex?.customerRef && String(ex.customerRef).trim()) || (input.fallbackCustomerRef || "");
    const spec = buildSpec({ fabricCode: it.fabricCode || "", sizeLabel: it.sizeLabel || "" }, ex);
    cur.items.push({
      // Invoice ref order (matches the current jsPDF invoice): PO / SO / REF / CO SO.
      orderRefs: [`PO: ${custPO || "-"}`, `SO: ${custSO || "-"}`, `REF: ${custRef || "-"}`, `CO SO: ${ourSO || "-"}`],
      code: it.productCode || "",
      name: it.productName || "",
      specLines: spec ? [spec] : [],
      set: it.quantity,
      priceSen: it.priceSen,
      lineTotalSen: it.lineTotalSen,
    });
  }

  return {
    kind: "INVOICE",
    docNo: input.invoiceNo,
    docDate: fmtDocDate(input.docDate),
    statusText: input.terms || "NET 30",
    leftFields: [
      ["Bill To", input.customerName || "-"],
      ["Address", input.billAddress || "-"],
      ["Contact", `${input.contactName || "-"}${input.contactPhone ? ` (${input.contactPhone})` : ""}`],
    ],
    rightFields: [
      ["Invoice No.", input.invoiceNo],
      ["DO No.", input.doNo || "-"],
      ["Date", fmtDocDate(input.docDate)],
      ["Terms", input.terms || "NET 30"],
      ["Due Date", fmtDocDate(input.dueDate)],
    ],
    groups,
    totalSets,
    subtotalSen: input.subtotalSen,
    taxSen: input.taxSen,
    totalSen: input.totalSen,
    amountInWords: input.amountInWords,
    logoPngBase64,
  };
}
