// ---------------------------------------------------------------------------
// doc-detail-listings — per-line-item "Detail Listing" exports for Purchase
// Orders, Goods Receipts and Delivery Orders, mirroring the Sales Order detail
// listing (so-detail-listing.ts): ONE ROW PER LINE ITEM, document header
// fields repeated on every line.
//
// The SO detail matches the owner's AutoCount SO export column-for-column
// because we have that reference (dridtable.xlsx). We do NOT have AutoCount
// reference exports for PO / GRN / DO, so each listing here uses that
// document's OWN real fields — a genuinely useful per-line detail, not a
// guessed clone of a layout we can't see. Send the AutoCount PO/GRN/DO
// detail exports and these can be aligned column-for-column like the SO one.
//
// Pure so the row mapping is unit-tested without a database.
// ---------------------------------------------------------------------------

import type { Aoa } from "./export-report";

const rm = (sen: number | null | undefined): number => Math.round(Number(sen) || 0) / 100;
const day = (iso: string | null | undefined): string => {
  const s = String(iso ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
};
const num = (v: number | null | undefined): number => Number(v) || 0;

// ── Purchase Order ─────────────────────────────────────────────────────────
export type PODetailItem = {
  materialCategory?: string | null;
  materialCode?: string | null;
  supplierSKU?: string | null;
  materialName?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPriceSen?: number | null;
  totalSen?: number | null;
  receivedQty?: number | null;
};
export type PODetailOrder = {
  poNo?: string | null;
  orderDate?: string | null;
  supplierName?: string | null;
  status?: string | null;
  totalSen?: number | null;
  items?: PODetailItem[] | null;
};

export const PO_DETAIL_HEADERS = [
  "Doc. No.", "Date", "Supplier", "Status", "Doc Total",
  "Item Group", "Material Code", "Supplier SKU", "Description", "UOM",
  "Qty", "Unit Price", "Line Total", "Received Qty",
] as const;

export function buildPoDetailListingAoa(orders: PODetailOrder[]): Aoa {
  const body: (string | number)[][] = [];
  for (const o of orders) {
    const items = o.items && o.items.length > 0 ? o.items : [{} as PODetailItem];
    for (const it of items) {
      body.push([
        o.poNo ?? "",
        day(o.orderDate),
        o.supplierName ?? "",
        o.status ?? "",
        rm(o.totalSen),
        it.materialCategory ?? "",
        it.materialCode ?? "",
        it.supplierSKU ?? "",
        it.materialName ?? "",
        it.unit ?? "",
        num(it.quantity),
        rm(it.unitPriceSen),
        rm(it.totalSen),
        num(it.receivedQty),
      ]);
    }
  }
  return [PO_DETAIL_HEADERS as unknown as string[], ...body];
}

// ── Goods Receipt Note ───────────────────────────────────────────────────────
export type GrnDetailItem = {
  materialCode?: string | null;
  supplierSKU?: string | null;
  materialName?: string | null;
  orderedQty?: number | null;
  receivedQty?: number | null;
  acceptedQty?: number | null;
  rejectedQty?: number | null;
  rejectionReason?: string | null;
  unitPrice?: number | null; // sen — see pi/create.tsx
};
export type GrnDetailNote = {
  grnNumber?: string | null;
  receiveDate?: string | null;
  supplierName?: string | null;
  status?: string | null;
  items?: GrnDetailItem[] | null;
};

export const GRN_DETAIL_HEADERS = [
  "GRN No.", "Date", "Supplier", "Status",
  "Material Code", "Supplier SKU", "Description",
  "Ordered Qty", "Received Qty", "Accepted Qty", "Rejected Qty",
  "Rejection Reason", "Unit Price", "Line Total",
] as const;

export function buildGrnDetailListingAoa(notes: GrnDetailNote[]): Aoa {
  const body: (string | number)[][] = [];
  for (const n of notes) {
    const items = n.items && n.items.length > 0 ? n.items : [{} as GrnDetailItem];
    for (const it of items) {
      // Billed line value = accepted × unit price, matching the PI pre-match.
      const lineTotalSen = num(it.acceptedQty) * num(it.unitPrice);
      body.push([
        n.grnNumber ?? "",
        day(n.receiveDate),
        n.supplierName ?? "",
        n.status ?? "",
        it.materialCode ?? "",
        it.supplierSKU ?? "",
        it.materialName ?? "",
        num(it.orderedQty),
        num(it.receivedQty),
        num(it.acceptedQty),
        num(it.rejectedQty),
        it.rejectionReason ?? "",
        rm(it.unitPrice),
        rm(lineTotalSen),
      ]);
    }
  }
  return [GRN_DETAIL_HEADERS as unknown as string[], ...body];
}

// ── Delivery Order ───────────────────────────────────────────────────────────
export type DoDetailItem = {
  salesOrderNo?: string | null;
  customerPOId?: string | null;
  productCode?: string | null;
  productName?: string | null;
  sizeLabel?: string | null;
  fabricCode?: string | null;
  quantity?: number | null;
  itemM3?: number | null;
  rackingNumber?: string | null;
};
export type DoDetailOrder = {
  doNo?: string | null;
  dispatchDate?: string | null;
  customerName?: string | null;
  status?: string | null;
  items?: DoDetailItem[] | null;
};

export const DO_DETAIL_HEADERS = [
  "DO No.", "Dispatch Date", "Customer", "Status",
  "Sales Order", "Customer PO", "Item Code", "Description",
  "Size", "Fabric", "Qty", "M3", "Racking",
] as const;

export function buildDoDetailListingAoa(orders: DoDetailOrder[]): Aoa {
  const body: (string | number)[][] = [];
  for (const o of orders) {
    const items = o.items && o.items.length > 0 ? o.items : [{} as DoDetailItem];
    for (const it of items) {
      body.push([
        o.doNo ?? "",
        day(o.dispatchDate),
        o.customerName ?? "",
        o.status ?? "",
        it.salesOrderNo ?? "",
        it.customerPOId ?? "",
        it.productCode ?? "",
        it.productName ?? "",
        it.sizeLabel ?? "",
        it.fabricCode ?? "",
        num(it.quantity),
        num(it.itemM3),
        it.rackingNumber ?? "",
      ]);
    }
  }
  return [DO_DETAIL_HEADERS as unknown as string[], ...body];
}
