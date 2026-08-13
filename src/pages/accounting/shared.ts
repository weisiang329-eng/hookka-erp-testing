// ---------------------------------------------------------------------------
// accounting/shared.ts — shared types + helpers for the Accounting page and
// its per-tab components under accounting/tabs/.
//
// 2026-07-04: the Accounting page was one ~9.6k-line file with all ~30 tabs
// inline. Splitting each tab into its own file (behaviour-identical) needs a
// home for the small pieces every tab uses. Move shared items here; index.tsx
// and every tab import from "./shared" (or "../shared").
// ---------------------------------------------------------------------------

export type MutationResponse =
  | { success: true; error?: string }
  | { success: false; error?: string };

// ---------------------------------------------------------------------------
// Multi-company — the Accounting company selector, and why it offers only the
// group option (BUG-2026-08-13-051).
//
// The finance report endpoints (/pl, /aging, /ar-control, /ap-control,
// /ar-reconciliation, /ap-reconciliation, /trial-balance) accept an OPTIONAL
// `?orgId=` which `companyFilter` (src/api/lib/tenant.ts:204-214) binds
// straight into `org_id = ?` / `orgId = ?` on ledger_journal_entries,
// invoices, purchase_invoices, customers and suppliers.
//
// `org_id` is the TENANT column — one value per LOGIN account, defaulting to
// `'hookka'` (tenant.ts:31, migration 0049's column DEFAULT, and the write
// side never stamps anything else: see BUG-CLASSES C12 row 7).
//
// The COMPANY a document is booked under is a different, DISPLAY dimension —
// `sales_orders.sales_org_code` / `purchase_orders.purchase_org_code`
// (src/lib/company-dimension.ts:1-20). This hook used to feed the selector
// `organisations.code.toLowerCase()` — HOOKKA / OHANA / HOUZS / HKMFG — into
// that tenant filter. Those are not the same dimension and never line up:
// migration 0142_organisations_registry.sql:92,100 seeds BOTH the HOOKKA and
// the OHANA organisation rows with `org_id = 'hookka'`.
//
// So the control had no correct state at all:
//   • picking OHANA / HOUZS / HKMFG filtered `org_id = 'ohana'` (etc.), which
//     matches nothing — P&L, Balance Sheet, AR, AP and the Trial Balance all
//     rendered EMPTY, with no error and no explanation;
//   • picking HOOKKA filtered `org_id = 'hookka'`, which matches EVERY row —
//     so it printed the whole group's money under one company's name;
//   • the Balance Sheet's "by company" card (GroupByCompanyCard) fetches
//     /pl per code and prints Net Profit + Total Equity per company, so it
//     showed RM 0.00 for all four. BUG-CLASS C15: a fabricated-looking figure
//     the owner would read and act on.
//
// There is NO mapping to substitute, and one must not be invented — a wrong
// org filter shows one company another company's money. A per-company P&L /
// Balance Sheet / TB would have to be derived from a company column on
// `ledger_journal_entries` and `invoices`, and NEITHER TABLE HAS ONE (checked
// against the production schema snapshot tests/db-schema.json: both carry
// `org_id` only; `sales_org_code` exists on `sales_orders` alone, and
// `purchase_org_code` on purchase_orders / purchase_invoices / suppliers).
// Adding that dimension, and backfilling it from each document's source, is
// the real feature — it is not a filter bug.
//
// Until then the only figure this page can state truthfully is the
// consolidated one, so that is the only option offered. `CompanySelect`
// hides itself for a single-option list and `GroupByCompanyCard` already
// returns null when no real company remains, so nothing renders a per-company
// number that does not exist.
//
// WHEN A SECOND TENANT IS SEEDED: this comes back keyed on the tenant
// dimension it actually filters — `organisations.org_id`, which
// GET /api/organisations does not currently emit (SELECT_COLS_NEW,
// src/api/routes/organisations.ts:152-155) — not on `code`.
//
// The empty-string value "" is the "All companies (group)" option; callers
// append `&orgId=<value>` ONLY when the value is non-empty, so the fetch URLs
// are byte-identical to the unfiltered reads that were always correct.
// ---------------------------------------------------------------------------
export type CompanyOption = { value: string; label: string };

// Module-level constant so the returned array has a STABLE identity: several
// callers pass it straight into a child whose effect deps include it, and a
// fresh array per render would re-fire those effects every paint.
const GROUP_ONLY_OPTIONS: CompanyOption[] = [
  { value: "", label: "All companies (group)" },
];

/**
 * Options for the Accounting company selector. Only the consolidated group
 * option today — see the block comment above for why a per-company option
 * cannot be produced truthfully from the current schema.
 */
export function useCompanyOptions(): CompanyOption[] {
  return GROUP_ONLY_OPTIONS;
}

/** Build the `&orgId=…` query suffix for a selected company (empty when group). */
export function orgIdParam(company: string): string {
  return company ? `&orgId=${encodeURIComponent(company)}` : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/** Narrow an unknown API JSON body to the repo's { success, error } envelope. */
export function asMutationResponse(v: unknown): MutationResponse | null {
  if (!isRecord(v)) return null;
  if (v.success === true) {
    return {
      success: true,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  if (v.success === false) {
    return {
      success: false,
      error: typeof v.error === "string" ? v.error : undefined,
    };
  }
  return null;
}
