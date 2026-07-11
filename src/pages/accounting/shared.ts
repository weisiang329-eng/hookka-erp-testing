// ---------------------------------------------------------------------------
// accounting/shared.ts — shared types + helpers for the Accounting page and
// its per-tab components under accounting/tabs/.
//
// 2026-07-04: the Accounting page was one ~9.6k-line file with all ~30 tabs
// inline. Splitting each tab into its own file (behaviour-identical) needs a
// home for the small pieces every tab uses. Move shared items here; index.tsx
// and every tab import from "./shared" (or "../shared").
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export type MutationResponse =
  | { success: true; error?: string }
  | { success: false; error?: string };

// ---------------------------------------------------------------------------
// Multi-company (Phase 2) — company selector data source.
//
// The finance report endpoints (/pl, /aging, /ar-control, /ap-control,
// /trial-balance) accept an OPTIONAL ?orgId=<code> that scopes the report to
// one sister company. NO param = today's consolidated (all-company) numbers,
// byte-identical to before Phase 2.
//
// The filter value the backend expects is the org CODE lower-cased (e.g.
// "hookka", "ohana") — NOT the org row id ("org-hookka"). companyFilter()
// matches ledger_journal_entries.orgId / invoices.orgId, which is the
// lower-cased code. So we map each organisation to
// { value: code.toLowerCase(), label: name }.
//
// The empty-string value "" is the DEFAULT "All companies (group)" option —
// callers append `&orgId=<value>` ONLY when value is non-empty, keeping the
// default fetch URL unchanged.
// ---------------------------------------------------------------------------
export type CompanyOption = { value: string; label: string };

type OrganisationsResp = {
  organisations?: { code?: string; name?: string; isActive?: boolean }[];
};

/**
 * Fetch the active sister companies for the company selector. Always returns
 * the "All companies (group)" option first (value ""), then one entry per
 * active organisation. On any error it degrades to just the group option, so
 * the report still renders exactly as today (consolidated).
 */
export function useCompanyOptions(): CompanyOption[] {
  const [orgs, setOrgs] = useState<CompanyOption[]>([]);
  useEffect(() => {
    let stale = false;
    fetch("/api/organisations")
      .then((r) => r.json() as Promise<OrganisationsResp>)
      .then((j) => {
        if (stale) return;
        const opts = (j?.organisations ?? [])
          .filter((o) => o.isActive !== false && typeof o.code === "string" && o.code)
          .map((o) => ({ value: (o.code as string).toLowerCase(), label: o.name || (o.code as string) }));
        setOrgs(opts);
      })
      .catch(() => {});
    return () => { stale = true; };
  }, []);
  return [{ value: "", label: "All companies (group)" }, ...orgs];
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
