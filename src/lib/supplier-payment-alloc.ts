// Pure per-allocation math for supplier payments. AP (400-0000) is cleared at
// the PI's BOOKED MYR; the bank pays the ACTUAL MYR; the difference is realised
// FX (530-0000). MYR PIs have no FX. All amounts in sen (integer).

export type AllocInput = {
  outstandingBookedSen: number; // PI remaining booked MYR (amountSen − paidAmountSen)
  isForeign: boolean;
  fxRate: number;               // booking rate (MYR per 1 foreign unit); 1 for MYR
  payMyrSen?: number;           // MYR PIs: the MYR being paid
  foreignSen?: number;          // foreign PIs: the foreign amount being paid (sen)
  payRate?: number;             // foreign PIs: payment-day rate (MYR per 1 foreign unit)
  full: boolean;                // paying off the entire remaining outstanding
};
export type AllocResult =
  | { ok: true; bookedSen: number; bankSen: number; fxDiffSen: number }
  | { ok: false; error: string };

export function computeAlloc(a: AllocInput): AllocResult {
  if (!a.isForeign) {
    const booked = Math.round(Number(a.payMyrSen) || 0);
    if (booked <= 0) return { ok: false, error: "amount must be > 0" };
    if (booked > a.outstandingBookedSen) return { ok: false, error: "amount exceeds outstanding" };
    return { ok: true, bookedSen: booked, bankSen: booked, fxDiffSen: 0 };
  }
  const payRate = Number(a.payRate) || 0;
  if (!(payRate > 0)) return { ok: false, error: "foreign invoice needs payment-day rate" };
  const foreign = Math.round(Number(a.foreignSen) || 0);
  if (foreign <= 0) return { ok: false, error: "amount must be > 0" };
  const booked = a.full ? a.outstandingBookedSen : Math.round(foreign * a.fxRate);
  if (booked <= 0) return { ok: false, error: "amount must be > 0" };
  if (booked > a.outstandingBookedSen) return { ok: false, error: "amount exceeds outstanding" };
  const bank = Math.round(foreign * payRate);
  return { ok: true, bookedSen: booked, bankSen: bank, fxDiffSen: booked - bank };
}

// ---------------------------------------------------------------------------
// Dual-keyed row field readers (BUG-2026-07-01-003).
//
// The Postgres adapter camelCases every result column (src/api/lib/db-pg.ts
// `transform: { column: { from: columnFrom } }`) regardless of how the SQL
// referenced or aliased it — a snake_case column reference/alias round-trips
// back into JS as its camelCase original (via column-rename-map.json or a
// postgres.toCamel fallback). A row field typed/read as snake_case is
// therefore only ever populated via its camelCase twin at runtime. Every
// reader of a `purchase_invoices` / `supplier_payments` row in
// src/api/routes/supplier-payments.ts must go through these instead of a
// bare `row.snake_case_field`.
// ---------------------------------------------------------------------------
export type DualKeyPiRow = {
  amountSen?: number | null;
  amount_sen?: number | null;
  paidAmountSen?: number | null;
  paid_amount_sen?: number | null;
};

/** PI's remaining booked MYR: amountSen − paidAmountSen, dual-keyed. */
export function piOutstandingSen(pi: DualKeyPiRow): number {
  const amountSen = Number(pi.amountSen ?? pi.amount_sen) || 0;
  const paidAmountSen = Number(pi.paidAmountSen ?? pi.paid_amount_sen) || 0;
  return amountSen - paidAmountSen;
}

export type DualKeyBookedRow = {
  bookedSen?: number | null;
  booked_sen?: number | null;
};

/** A supplier_payments row's bookedSen, dual-keyed. */
export function readBookedSen(row: DualKeyBookedRow): number {
  return Number(row.bookedSen ?? row.booked_sen) || 0;
}

// ---------------------------------------------------------------------------
// Restate headroom (BUG-2026-07-09-001). Restate edits a payment IN PLACE:
// its own old rows are rolled back inside the same batch, so validating the
// NEW allocations against the PI's current paid_amount_sen double-counts the
// very amount being edited — a payment that fully paid its PI could never be
// restated (status PAID was rejected AND outstanding read 0). The PI must be
// treated as if this payment's old booking were already rolled back.
// ---------------------------------------------------------------------------
export function restateHeadroom(
  pi: DualKeyPiRow & { status?: string | null },
  ownOldBookedSen: number,
): { payable: boolean; outstandingBookedSen: number } {
  const status = String(pi.status ?? "");
  const own = Math.max(0, Math.round(Number(ownOldBookedSen) || 0));
  const payable =
    status === "CONFIRMED" ||
    status === "APPROVED" ||
    status === "PARTIAL_PAID" ||
    (status === "PAID" && own > 0);
  return { payable, outstandingBookedSen: piOutstandingSen(pi) + own };
}

// ---------------------------------------------------------------------------
// The GL family that is LIVE for an edited payment: each restate collapses the
// older families to hidden, so the newest supplier_payment_restate_post:<stamp>
// wins over the base supplier_payment legs. Pure so the unvoid repair
// (BUG-2026-07-24-002) is unit-testable.
// ---------------------------------------------------------------------------
export function latestRestatePostType(sourceTypes: string[]): string | null {
  let best: string | null = null;
  let bestStamp = -1;
  for (const t of sourceTypes) {
    if (!t.startsWith("supplier_payment_restate_post:")) continue;
    const stamp = Number(t.split(":")[1]) || 0;
    if (stamp > bestStamp) {
      bestStamp = stamp;
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// GET /api/supplier-payments row grouping — pure so it's directly testable
// with the camelCase-only shape the live adapter actually produces (see
// BUG-2026-07-01-003: the old inline loop read snake_case and silently
// dropped every row via `if (!payNo) continue`).
// ---------------------------------------------------------------------------
export type RawSupplierPaymentRow = {
  id: string;
  paymentNo?: string | null; payment_no?: string | null;
  supplierId?: string | null; supplier_id?: string | null;
  supplierName?: string | null; supplier_name?: string | null;
  purchaseInvoiceId?: string | null; purchase_invoice_id?: string | null;
  date?: string | null;
  amountSen?: number | null; amount_sen?: number | null;
  bookedSen?: number | null; booked_sen?: number | null;
  piNo?: string | null; pi_no?: string | null;
  supplierInvoiceNo?: string | null; supplier_invoice_no?: string | null;
  lifecycleState?: string | null;
};

export type SupplierPaymentLine = {
  id: string;
  purchaseInvoiceId: string;
  piNo?: string;
  supplierInvoiceNo?: string;
  amountSen: number;
  bookedSen: number;
};

export type SupplierPaymentGroup = {
  paymentNo: string;
  supplierId: string;
  supplierName: string;
  date: string;
  totalBankSen: number;
  totalBookedSen: number;
  lines: SupplierPaymentLine[];
  lifecycleState: string;
};

/** Groups flat (payment × PI-line) rows into one entry per payment_no. */
export function groupSupplierPaymentRows(
  rows: RawSupplierPaymentRow[],
): SupplierPaymentGroup[] {
  const groups = new Map<string, SupplierPaymentGroup>();
  for (const row of rows) {
    const payNo = row.paymentNo ?? row.payment_no ?? "";
    if (!payNo) continue;
    let g = groups.get(payNo);
    if (!g) {
      g = {
        paymentNo: payNo,
        supplierId: row.supplierId ?? row.supplier_id ?? "",
        supplierName: row.supplierName ?? row.supplier_name ?? "",
        date: row.date ?? "",
        totalBankSen: 0,
        totalBookedSen: 0,
        lines: [],
        lifecycleState: row.lifecycleState ?? "ACTIVE",
      };
      groups.set(payNo, g);
    }
    const amountSen = Number(row.amountSen ?? row.amount_sen) || 0;
    const bookedSen = readBookedSen(row);
    g.totalBankSen += amountSen;
    g.totalBookedSen += bookedSen;
    g.lines.push({
      id: row.id,
      purchaseInvoiceId: row.purchaseInvoiceId ?? row.purchase_invoice_id ?? "",
      piNo: row.piNo ?? row.pi_no ?? undefined,
      supplierInvoiceNo: row.supplierInvoiceNo ?? row.supplier_invoice_no ?? "",
      amountSen,
      bookedSen,
    });
  }
  return [...groups.values()];
}
