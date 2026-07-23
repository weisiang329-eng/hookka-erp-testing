// ---------------------------------------------------------------------------
// unified-doc-download.ts — browser-side download of the DO / Invoice via the
// SAME pdf-lib generator the backend auto-email uses. Maps the page's order +
// /print-extras into the normalized builder input, renders, and saves the file.
// This is what makes "edit the template in ONE place" real: download and email
// share unified-do-invoice-pdf.ts.
// ---------------------------------------------------------------------------
import {
  buildUnifiedDoData,
  buildUnifiedInvoiceData,
  buildUnifiedSalesOrderData,
  type UnifiedDoInput,
  type UnifiedInvoiceInput,
  type UnifiedSalesOrderInput,
  type DocLineExtra,
} from "./build-unified-doc-data";
import { buildUnifiedDocPdf } from "../api/lib/unified-do-invoice-pdf";
import { HOOKKA_LOGO_PNG_BASE64 } from "../api/lib/hookka-logo-base64";
import { PDFDocument } from "pdf-lib";

function triggerDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.slice()], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // eslint-disable-next-line no-restricted-syntax -- one-shot object-URL cleanup, not a React timer
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Loosely-typed shapes — the FES pass their own DO/Invoice + the /print-extras
// blob; both carry a superset of what we read here.
type AnyExtras = {
  customerSO?: string;
  customerRef?: string;
  deliverTo?: string;
  deliveryAddress?: string;
  hubContactName?: string;
  hubContactPhone?: string;
  // Loosely typed — DO and Invoice print-extras carry slightly different per-item
  // shapes; both are structural supersets of DocLineExtra, read defensively below.
  items?: Record<string, unknown>;
} | undefined;

const extraOf = (extras: AnyExtras, id: string): DocLineExtra | undefined =>
  (extras?.items?.[id] as DocLineExtra | undefined) ?? undefined;

type AnyOrder = Record<string, unknown> & {
  doNo?: string;
  customerName?: string;
  deliveryDate?: string;
  deliveryAddress?: string;
  driverName?: string;
  vehicleNo?: string;
  contactPerson?: string;
  contactPhone?: string;
  items?: Array<Record<string, unknown>>;
};

function s(v: unknown): string {
  return v == null ? "" : String(v);
}

// Uint8Array → base64 (chunked; a spread over a multi-page PDF's bytes blows
// the call-stack). Used to pass the unified PDF to the notify endpoint.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function doInputFromOrder(order: AnyOrder, extras: AnyExtras): UnifiedDoInput {
  return {
    doNo: s(order.doNo),
    docDate: s(order.deliveryDate),
    customerName: s(order.customerName),
    deliverTo: extras?.deliverTo || s((order as { hubName?: string }).hubName),
    deliveryAddress: extras?.deliveryAddress || s(order.deliveryAddress),
    contactName: extras?.hubContactName || s(order.contactPerson),
    contactPhone: extras?.hubContactPhone || s(order.contactPhone),
    driverName: s(order.driverName),
    driverPhone: s((order as { driverPhone?: string }).driverPhone),
    lorryPlate: s(order.vehicleNo),
    fallbackCustomerSO: extras?.customerSO,
    fallbackCustomerRef: extras?.customerRef,
    items: (order.items || []).map((it) => ({
      id: s(it.id),
      productCode: s(it.productCode),
      productName: s(it.productName),
      fabricCode: s(it.fabricCode),
      sizeLabel: s(it.sizeLabel),
      quantity: Number(it.quantity) || 0,
      extra: extraOf(extras, s(it.id)),
    })),
  };
}

export async function downloadUnifiedDoPdf(order: AnyOrder, extras: AnyExtras): Promise<void> {
  const bytes = await buildUnifiedDocPdf(buildUnifiedDoData(doInputFromOrder(order, extras), HOOKKA_LOGO_PNG_BASE64));
  triggerDownload(bytes, `${s(order.doNo) || "DO"}.pdf`);
}

// Backend-parity DO renderer (returns bytes, no download) — used when a caller
// needs the PDF bytes (e.g. batch, blob upload) rather than a browser save.
export async function renderUnifiedDoBytes(order: AnyOrder, extras: AnyExtras): Promise<Uint8Array> {
  return buildUnifiedDocPdf(buildUnifiedDoData(doInputFromOrder(order, extras), HOOKKA_LOGO_PNG_BASE64));
}

// base64 for the customer-notify POST — the email carries the SAME PDF as the
// download so the customer never gets the old simplified fallback.
export async function renderUnifiedDoBase64(order: AnyOrder, extras: AnyExtras): Promise<string> {
  return bytesToBase64(await renderUnifiedDoBytes(order, extras));
}

type AnyInvoice = Record<string, unknown> & {
  invoiceNo?: string;
  doNo?: string;
  invoiceDate?: string;
  dueDate?: string;
  terms?: string;
  customerName?: string;
  billingAddress?: string;
  subtotalSen?: number;
  taxSen?: number;
  totalSen?: number;
  amountInWords?: string;
  items?: Array<Record<string, unknown>>;
};

export function invoiceInputFromInvoice(inv: AnyInvoice, extras: AnyExtras): UnifiedInvoiceInput {
  return {
    invoiceNo: s(inv.invoiceNo),
    doNo: s(inv.doNo),
    docDate: s(inv.invoiceDate),
    dueDate: s(inv.dueDate),
    terms: s(inv.terms) || "NET 30",
    customerName: s(inv.customerName),
    billAddress: extras?.deliveryAddress || s(inv.billingAddress),
    contactName: extras?.hubContactName || s((inv as { contactPerson?: string }).contactPerson),
    contactPhone: extras?.hubContactPhone || s((inv as { contactPhone?: string }).contactPhone),
    fallbackCustomerSO: extras?.customerSO,
    fallbackCustomerRef: extras?.customerRef,
    items: (inv.items || []).map((it) => ({
      id: s(it.id),
      productCode: s(it.productCode),
      productName: s(it.productName) || s(it.description),
      fabricCode: s(it.fabricCode),
      sizeLabel: s(it.sizeLabel),
      quantity: Number(it.quantity) || 1,
      priceSen: Number(it.unitPriceSen ?? it.priceSen) || 0,
      lineTotalSen: Number(it.totalSen ?? it.lineTotalSen) || 0,
      extra: extraOf(extras, s(it.id)),
    })),
    subtotalSen: Number(inv.subtotalSen) || Number(inv.totalSen) || 0,
    taxSen: Number(inv.taxSen) || 0,
    totalSen: Number(inv.totalSen) || 0,
    amountInWords: s(inv.amountInWords) || undefined,
  };
}

export async function downloadUnifiedInvoicePdf(inv: AnyInvoice, extras: AnyExtras): Promise<void> {
  const bytes = await buildUnifiedDocPdf(buildUnifiedInvoiceData(invoiceInputFromInvoice(inv, extras), HOOKKA_LOGO_PNG_BASE64));
  triggerDownload(bytes, `${s(inv.invoiceNo) || "INVOICE"}.pdf`);
}

export async function renderUnifiedInvoiceBytes(inv: AnyInvoice, extras: AnyExtras): Promise<Uint8Array> {
  return buildUnifiedDocPdf(buildUnifiedInvoiceData(invoiceInputFromInvoice(inv, extras), HOOKKA_LOGO_PNG_BASE64));
}

export async function renderUnifiedInvoiceBase64(inv: AnyInvoice, extras: AnyExtras): Promise<string> {
  return bytesToBase64(await renderUnifiedInvoiceBytes(inv, extras));
}

// Batch download — render every selected invoice with the SAME unified
// generator, then merge them into ONE multi-page PDF (pdf-lib copyPages) the
// operator opens/prints in a single go. Replaces the jsPDF generateCombined*
// path so a bulk download looks identical to a single download.
export async function downloadCombinedUnifiedInvoicePdf(
  items: Array<{ invoice: AnyInvoice; extras: AnyExtras }>,
  filename: string,
): Promise<void> {
  const merged = await PDFDocument.create();
  for (const { invoice, extras } of items) {
    const bytes = await renderUnifiedInvoiceBytes(invoice, extras);
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  triggerDownload(await merged.save(), filename);
}

// ── Sales Order — reuse the invoice-style unified template ────────────────
// The SO's own item columns already carry every price component, so no
// print-extras lookup is needed — we build `extra` straight off the item.
export function salesOrderInputFromOrder(order: AnyOrder): UnifiedSalesOrderInput {
  const o = order as Record<string, unknown>;
  return {
    soNo: s(o.companySOId ?? o.companySO),
    docDate: s(o.companySODate ?? o.createdAt),
    customerName: s(o.customerName),
    billAddress: s(o.companyAddress ?? o.billingAddress ?? o.customerAddress),
    customerPOId: s(o.customerPOId),
    customerSOId: s(o.customerSOId ?? o.customerSO),
    terms: "NET 30",
    items: ((o.items as Array<Record<string, unknown>>) || []).map((it) => {
      const gap = Number(it.gapInches) || 0;
      const dv = Number(it.divanHeightInches) || 0;
      const lg = Number(it.legHeightInches) || 0;
      return {
        id: s(it.id),
        productCode: s(it.productCode),
        productName: s(it.productName),
        fabricCode: s(it.fabricCode),
        sizeLabel: s(it.sizeLabel),
        quantity: Number(it.quantity) || 1,
        priceSen: Number(it.unitPriceSen) || 0,
        lineTotalSen:
          Number(it.lineTotalSen) ||
          (Number(it.unitPriceSen) || 0) * (Number(it.quantity) || 1),
        extra: {
          itemCategory: (it.itemCategory as string) ?? null,
          gapInches: gap || null,
          divanHeightInches: dv || null,
          legHeightInches: lg || null,
          totalHeightInches: gap + dv + lg || null,
          specialOrder: (it.specialOrder as string) ?? null,
          baseSen: Number(it.basePriceSen) || 0,
          divanSen: Number(it.divanPriceSen) || 0,
          legSen: Number(it.legPriceSen) || 0,
          specialSen: Number(it.specialOrderPriceSen) || 0,
          totalHeightSen: Number(it.totalHeightPriceSen) || 0,
        } as DocLineExtra,
      };
    }),
    subtotalSen: Number(o.subtotalSen) || Number(o.totalSen) || 0,
    totalSen: Number(o.totalSen) || 0,
  };
}

export async function renderUnifiedSalesOrderBytes(order: AnyOrder): Promise<Uint8Array> {
  return buildUnifiedDocPdf(
    buildUnifiedSalesOrderData(salesOrderInputFromOrder(order), HOOKKA_LOGO_PNG_BASE64),
  );
}

export async function downloadUnifiedSalesOrderPdf(order: AnyOrder): Promise<void> {
  const bytes = await renderUnifiedSalesOrderBytes(order);
  triggerDownload(
    bytes,
    `${s((order as Record<string, unknown>).companySOId) || "SO"}.pdf`,
  );
}

export async function downloadCombinedUnifiedSalesOrderPdf(
  orders: AnyOrder[],
  filename: string,
): Promise<void> {
  const merged = await PDFDocument.create();
  for (const order of orders) {
    const bytes = await renderUnifiedSalesOrderBytes(order);
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  triggerDownload(await merged.save(), filename);
}

// Batch download of DOs — same merge, unified DO generator.
export async function downloadCombinedUnifiedDoPdf(
  items: Array<{ order: AnyOrder; extras: AnyExtras }>,
  filename: string,
): Promise<void> {
  const merged = await PDFDocument.create();
  for (const { order, extras } of items) {
    const bytes = await renderUnifiedDoBytes(order, extras);
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  triggerDownload(await merged.save(), filename);
}
