// Sales Order PDF — now rendered by the SHARED unified generator (pdf-lib),
// identical layout to the Invoice: the Price column itemises
// Base + Divan + Leg + T.Height + Special = unit (owner 2026-07-23: "SO 统一成
// 发票那种格式"). Previously this wrapped the jsPDF generate-order-pdf.ts; that
// file stays in place for CO (consignment) until/if it is migrated too.
import type { SalesOrder, Customer } from "@/lib/mock-data";
import {
  downloadUnifiedSalesOrderPdf,
  downloadCombinedUnifiedSalesOrderPdf,
} from "./unified-doc-download";

// The unified download reads a superset of SalesOrder's runtime fields
// (companySOId / customerPOId / items[].basePriceSen / divanPriceSen / … ).
type LooseOrder = Parameters<typeof downloadUnifiedSalesOrderPdf>[0];

export async function generateSOPdf(
  order: SalesOrder,
  _customer?: Customer | null,
): Promise<void> {
  await downloadUnifiedSalesOrderPdf(order as unknown as LooseOrder);
}

// Bulk "Download PDF" — merge several sales orders into ONE file, via the same
// unified generator + pdf-lib copyPages (replaces the old jsPDF merge).
export async function generateCombinedSOPdf(
  items: { order: SalesOrder; customer?: Customer | null }[],
  filename = "SalesOrders.pdf",
): Promise<void> {
  if (items.length === 0) return;
  await downloadCombinedUnifiedSalesOrderPdf(
    items.map((i) => i.order as unknown as LooseOrder),
    filename,
  );
}
