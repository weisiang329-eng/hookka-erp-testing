// Consignment Order PDF — rendered by the SHARED unified generator (pdf-lib),
// identical layout to the Sales Order / Invoice / DO: itemised Price column
// (Base + Divan + Leg + T.Height + Special = unit) and the DO ref standard
// (Our CO / PO / CO / REF). Previously wrapped the jsPDF generate-order-pdf.ts.
import type { Customer } from "@/lib/mock-data";
import type { ConsignmentOrder } from "@/types";
import {
  downloadUnifiedConsignmentOrderPdf,
  downloadCombinedUnifiedConsignmentOrderPdf,
} from "./unified-doc-download";

type LooseOrder = Parameters<typeof downloadUnifiedConsignmentOrderPdf>[0];
const addrOf = (c?: Customer | null): string | undefined =>
  (c as { companyAddress?: string } | null | undefined)?.companyAddress;

export async function generateCOPdf(
  order: ConsignmentOrder,
  customer?: Customer | null,
): Promise<void> {
  await downloadUnifiedConsignmentOrderPdf(order as unknown as LooseOrder, addrOf(customer));
}

export async function generateCombinedCOPdf(
  items: { order: ConsignmentOrder; customer?: Customer | null }[],
  filename = "ConsignmentOrders.pdf",
): Promise<void> {
  if (items.length === 0) return;
  await downloadCombinedUnifiedConsignmentOrderPdf(
    items.map((i) => ({ order: i.order as unknown as LooseOrder, billAddress: addrOf(i.customer) })),
    filename,
  );
}
