// Sales Order PDF — rendered by the SHARED unified generator (pdf-lib),
// identical layout to the Invoice / DO: the Price column itemises
// Base + Divan + Leg + T.Height + Special = unit, and the Order column follows
// the DO ref standard (Our SO / PO / SO / REF). The customer's company address
// fills the "Bill To" block (the SO row doesn't carry it).
import type { SalesOrder, Customer } from "@/lib/mock-data";
import {
  downloadUnifiedSalesOrderPdf,
  downloadCombinedUnifiedSalesOrderPdf,
} from "./unified-doc-download";

// The unified download reads a superset of SalesOrder's runtime fields
// (companySOId / customerPOId / reference / items[].basePriceSen / … ).
type LooseOrder = Parameters<typeof downloadUnifiedSalesOrderPdf>[0];
const addrOf = (c?: Customer | null): string | undefined =>
  (c as { companyAddress?: string } | null | undefined)?.companyAddress;

export async function generateSOPdf(
  order: SalesOrder,
  customer?: Customer | null,
): Promise<void> {
  await downloadUnifiedSalesOrderPdf(order as unknown as LooseOrder, addrOf(customer));
}

// Bulk "Download PDF" — merge several sales orders into ONE file, via the same
// unified generator + pdf-lib copyPages (replaces the old jsPDF merge).
export async function generateCombinedSOPdf(
  items: { order: SalesOrder; customer?: Customer | null }[],
  filename = "SalesOrders.pdf",
): Promise<void> {
  if (items.length === 0) return;
  await downloadCombinedUnifiedSalesOrderPdf(
    items.map((i) => ({ order: i.order as unknown as LooseOrder, billAddress: addrOf(i.customer) })),
    filename,
  );
}
