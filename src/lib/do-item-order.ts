// Shared display / print ordering for Delivery Order line items.
//
// DISPLAY ONLY — sort a COPY of the items array. Never mutate stored data,
// totals, or the payload sent to the backend; this only controls the order
// lines are shown on screen and printed.
//
// Order: customer PO no. ascending (natural/numeric so PO-008636 <
// PO-008654 < PO-008770), then our SO no. ascending, so identical Customer
// PO / SO group together. Lines with no customer PO sort LAST, not first.
export function compareDoLinesByCustomerPO(
  a: { customerPOId?: string | null; salesOrderNo?: string | null },
  b: { customerPOId?: string | null; salesOrderNo?: string | null },
): number {
  const poA = (a.customerPOId || "").trim();
  const poB = (b.customerPOId || "").trim();
  // Blank customer PO sorts last.
  if (!poA && poB) return 1;
  if (poA && !poB) return -1;
  if (poA && poB) {
    const c = poA.localeCompare(poB, undefined, { numeric: true });
    if (c !== 0) return c;
  }
  const soA = (a.salesOrderNo || "").trim();
  const soB = (b.salesOrderNo || "").trim();
  if (!soA && soB) return 1;
  if (soA && !soB) return -1;
  return soA.localeCompare(soB, undefined, { numeric: true });
}
