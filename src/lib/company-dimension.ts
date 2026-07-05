// ---------------------------------------------------------------------------
// company-dimension.ts — Multi-Company Phase 2 shared helpers.
//
// The "company" a document is booked under (HOOKKA / OHANA / HOUZS / HKMFG …)
// is a DISPLAY / FILTER dimension, independent of the tenant-isolation `orgId`
// column. Sales Orders carry it as `sales_org_code`; Purchase Orders carry it
// as `purchase_org_code`. Both mirror the same rules:
//
//   • ADDITIVE / default-safe: an omitted, blank, or non-string value resolves
//     to the DEFAULT company (HOOKKA) so existing documents and callers that
//     don't send the field behave exactly as before.
//   • Codes are stored UPPERCASE to match the `organisations.code` convention
//     (the create dropdowns feed `organisations.code`, which is uppercase).
//   • The list filter default is "ALL companies" ("" / null) — see
//     `matchesCompanyFilter`: an empty filter matches every row so the default
//     list view shows everything (byte-identical to before this feature).
//
// Pure functions only (no DB / no Hono) so they're trivially unit-tested and
// reused identically on the frontend filter and the backend write path.
// ---------------------------------------------------------------------------

/** The company every existing document belongs to and the fallback default. */
export const DEFAULT_COMPANY_CODE = "HOOKKA";

/**
 * Normalise a company code coming off a create/edit request body. Returns the
 * uppercased trimmed code, or DEFAULT_COMPANY_CODE when the input is missing,
 * blank, or not a string. This is what gets written to
 * sales_org_code / purchase_org_code — it is NEVER null/empty so the column
 * default and the read-side fallback always agree.
 */
export function resolveCompanyCode(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed.toUpperCase();
  }
  return DEFAULT_COMPANY_CODE;
}

/**
 * Read-side coalesce: given the (possibly dual-keyed / null) stored value,
 * return the display code, defaulting to HOOKKA for rows written before the
 * column existed. Accepts the camelCase and snake_case values in that order.
 */
export function readCompanyCode(
  camel?: string | null,
  snake?: string | null,
): string {
  const v = camel ?? snake ?? "";
  return typeof v === "string" && v.trim().length > 0
    ? v.trim().toUpperCase()
    : DEFAULT_COMPANY_CODE;
}

/**
 * List-filter predicate. An empty / null filter means "ALL companies" and
 * matches every row (the default list view — nothing hidden). Otherwise the
 * row's company (defaulting to HOOKKA when unset) must equal the filter.
 */
export function matchesCompanyFilter(
  rowCompany: string | null | undefined,
  filter: string | null | undefined,
): boolean {
  const f = typeof filter === "string" ? filter.trim() : "";
  if (f.length === 0) return true; // ALL companies
  const rc = readCompanyCode(rowCompany ?? undefined);
  return rc === f.toUpperCase();
}

// ---------------------------------------------------------------------------
// Multi-Company Phase 4 — order allocation (bulk re-assign company).
//
// Reassigning which company a Sales Order is booked under is safe ONLY while
// the order is still early in its lifecycle. Once production orders, delivery
// orders or an invoice have been fanned out, those downstream documents (and
// the accounting attribution they carry) were created under the ORIGINAL
// company — silently swapping the SO's company would leave the SO showing one
// company while its POs/DOs/invoices belong to another, corrupting the
// per-company books. So bulk-reassign is gated to the pre-production statuses.
//
// Reassignable  : DRAFT, CONFIRMED, ON_HOLD  (nothing downstream committed yet;
//                 CONFIRMED before its PO cascade, or ON_HOLD paused early).
// NOT allowed   : IN_PRODUCTION, READY_TO_SHIP, SHIPPED, DELIVERED, INVOICED,
//                 CLOSED (downstream docs / invoice already booked) and
//                 CANCELLED (terminal — reassigning a dead order is pointless
//                 and would only muddy the company books).
//
// This is the CONSERVATIVE default the owner asked for: "if unsure, only allow
// reassign on DRAFT/early-status SOs". The auto-allocation RULE itself is
// deferred to the owner — this helper only guards the manual mechanism.
// ---------------------------------------------------------------------------

/** SO statuses whose company (`sales_org_code`) may be reassigned in bulk. */
export const REASSIGNABLE_STATUSES: readonly string[] = [
  "DRAFT",
  "CONFIRMED",
  "ON_HOLD",
];

/**
 * True when an SO in `status` is early enough that its booked company can be
 * safely reassigned (no production / delivery / invoice cascade committed yet).
 * Unknown / missing statuses are treated as NOT reassignable (fail closed).
 */
export function isCompanyReassignable(status: string | null | undefined): boolean {
  const s = typeof status === "string" ? status.trim().toUpperCase() : "";
  return REASSIGNABLE_STATUSES.includes(s);
}

/** One SO row's view for the batch-reassign decision. */
export type BatchReassignRow = {
  id: string;
  companySOId?: string | null;
  status: string;
  /** The row's current stored company (snake_case value / null for pre-column). */
  currentCompany?: string | null;
};

/** Per-row outcome of a batch-reassign decision. */
export type BatchReassignOutcome = {
  id: string;
  companySOId: string;
  status: string;
  /** True → this row should be UPDATEd to `target`. */
  moved: boolean;
  /** Present when moved=false — why it was held back. */
  reason?: string;
};

/**
 * Pure decision core for POST /api/sales-orders/batch-company. Given the found
 * rows and a normalised target company, classify each into moved / skipped.
 * The endpoint just executes the UPDATEs for `moved` rows — all the lock-guard
 * + no-op + already-there logic lives here so it's unit-testable without a DB.
 *
 * Rules (ADDITIVE-safe):
 *   • status not in REASSIGNABLE_STATUSES → skipped ("Locked …").
 *   • already on the target company        → skipped ("Already <CO>").
 *   • otherwise                             → moved.
 *
 * `target` MUST already be a canonical uppercased code (resolveCompanyCode).
 */
export function classifyBatchReassign(
  rows: readonly BatchReassignRow[],
  target: string,
): BatchReassignOutcome[] {
  const tgt = readCompanyCode(target); // canonicalise defensively
  return rows.map((row) => {
    const label = row.companySOId ?? row.id;
    if (!isCompanyReassignable(row.status)) {
      return {
        id: row.id,
        companySOId: label,
        status: row.status,
        moved: false,
        reason: `Locked — ${row.status} orders can't be reassigned (only ${REASSIGNABLE_STATUSES.join(" / ")}).`,
      };
    }
    const current = readCompanyCode(null, row.currentCompany ?? null);
    if (current === tgt) {
      return {
        id: row.id,
        companySOId: label,
        status: row.status,
        moved: false,
        reason: `Already ${tgt}`,
      };
    }
    return { id: row.id, companySOId: label, status: row.status, moved: true };
  });
}
