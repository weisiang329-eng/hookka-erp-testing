// ---------------------------------------------------------------------------
// customer-stage.ts — the billable boundary (owner 2026-08-01).
//
// A POTENTIAL customer is created from the Sales Pipeline the moment a lead is
// entered, so the salesperson can assign SKUs, set a sofa combo and export a
// quotation before anything is agreed. Such an account has NOT been through the
// Confirm gate: it may have no creditor code, no credit terms and no credit
// limit.
//
// Therefore it must never reach a money document. This guard is the boundary,
// and it lives SERVER-SIDE on purpose: hiding potential customers from a picker
// is a convenience, not a control — an API caller, an import, a stale tab or a
// future screen would all walk straight past a UI-only filter and put an
// unbillable account into the ledger.
//
// Quotations are deliberately NOT gated. A quotation commits nothing; being able
// to quote a potential customer is the entire point of the feature.
// ---------------------------------------------------------------------------

/** Stage as stored. Anything unrecognised is treated as CONFIRMED — existing
 *  rows predate the column and every one of them is a real account. */
export function stageOf(row: Record<string, unknown> | null | undefined): "POTENTIAL" | "CONFIRMED" {
  if (!row) return "CONFIRMED";
  // Dual-keyed: the Supabase driver's transform returns camelCase (db-pg.ts).
  const raw = String(row.customerStage ?? row.customer_stage ?? "").toUpperCase();
  return raw === "POTENTIAL" ? "POTENTIAL" : "CONFIRMED";
}

export type BillableCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Reject a POTENTIAL customer on any document that creates a financial
 * obligation (Sales Order, Invoice, Delivery Order, and anything downstream).
 *
 * Returns `{ ok: true }` when the customer is missing entirely — a missing
 * customer is the caller's own validation problem and every one of these routes
 * already reports it more precisely than this guard could.
 */
export async function assertCustomerBillable(
  db: D1Database,
  customerId: string | null | undefined,
  documentLabel = "this document",
): Promise<BillableCheck> {
  const id = String(customerId ?? "").trim();
  if (!id) return { ok: true };
  let row: Record<string, unknown> | null = null;
  try {
    row = await db
      .prepare("SELECT id, code, name, customer_stage FROM customers WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
  } catch {
    // The column self-applies on the customers routes; if this query throws
    // (e.g. the very first request after deploy, before any customers read),
    // fail OPEN. Blocking every sales order on a transient schema race would
    // be a far worse outcome than briefly missing the guard, and the customer
    // still cannot be created as POTENTIAL without that same column existing.
    return { ok: true };
  }
  if (!row) return { ok: true };
  if (stageOf(row) === "POTENTIAL") {
    const name = String(row.name ?? "").trim() || id;
    return {
      ok: false,
      error:
        `${name} is still a potential customer, so it cannot be used on ${documentLabel}. ` +
        `Confirm the customer first (Customers → Confirm) — that is where the creditor code, ` +
        `credit terms and credit limit are set.`,
    };
  }
  return { ok: true };
}
