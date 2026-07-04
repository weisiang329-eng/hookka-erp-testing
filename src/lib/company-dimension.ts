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
