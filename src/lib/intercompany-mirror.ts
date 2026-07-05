// ---------------------------------------------------------------------------
// intercompany-mirror.ts — Multi-Company Phase 3 shared decision logic.
//
// Dual-identity + inter-company document mirroring — the FOUNDATION only.
//
// The problem this solves: a company in the group (HOOKKA / OHANA / HOUZS /
// HKMFG) can be BOTH a customer of ours (it buys from us → AR, a Sales Order
// stream) AND a supplier we buy from/through (→ AP, a Purchase Order stream).
// customers and suppliers are SEPARATE tables with NO foreign-key link. To do
// inter-company mirroring we first need to KNOW that a given customer row and a
// given supplier row are the SAME real group company.
//
// Dual-identity storage (ADDITIVE, opt-in, default OFF):
//   • suppliers already carry `is_group_company` (migration 0023). We ADD a
//     snake_case `group_org_code` on BOTH customers and suppliers. When set to
//     a group org code (e.g. "HOUZS"), that party IS that group company. NULL /
//     "" = a normal external party (the default) — nothing changes for it.
//   • The org code ties the two tables together: a customer with
//     group_org_code = "HOUZS" and a supplier with group_org_code = "HOUZS" are
//     understood to be the one real Houzs Century company, wearing its two hats.
//
// The mirror (ADDITIVE, opt-in, idempotent):
//   • When a Purchase Order's purchase company (`purchase_org_code`) is HOOKKA
//     (we are buying) and the SUPPLIER is a flagged group company that is a
//     SISTER org (not HOOKKA itself), we auto-create a mirror SALES ORDER under
//     that sister company (`sales_org_code = <sister>`), with HOOKKA as the
//     customer. One company's PO ⟷ the other's SO.
//   • Fires ONLY when the global `auto_create_mirror_docs` config is ON.
//   • Idempotent: an `intercompany_mirror_log` guard (unique on
//     source_type+source_id) prevents a retry/re-save from double-creating.
//
// This module is PURE (no DB, no Hono) so the decision is unit-tested in
// isolation and reused identically wherever a mirror could fire (PO create,
// and later GRN). The DB reads/writes live in the route.
//
// SCOPE NOTE / TODO(P&L): This is the document-mirroring foundation ONLY. It
// does NOT attempt consolidated-P&L inter-company profit elimination (removing
// the intra-group margin so group accounts don't double-count a sale that is
// really an internal transfer). That is a deliberate later phase — see the
// TODO(intercompany-pnl-elimination) markers. Do not infer any accounting
// treatment from the mirror docs alone.
// ---------------------------------------------------------------------------

import { normalizeCompanyName } from "./company-name-match";

/** The buying/booking entity every existing document defaults to. */
export const DEFAULT_COMPANY_CODE = "HOOKKA";

/**
 * Normalise a group-org-code value coming off a customer/supplier row or a
 * request body. Returns the uppercased trimmed code, or "" when the party is
 * NOT flagged as a group company (missing / blank / non-string). "" is the
 * default-off state — a normal external party.
 */
export function resolveGroupOrgCode(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed.toUpperCase();
  }
  return "";
}

/**
 * Read-side dual-key coalesce for the group_org_code column. Accepts the
 * camelCase then snake_case value (SELECT * projects camelCase; explicit SQL
 * may alias snake). Returns "" when the party is not a flagged group company.
 */
export function readGroupOrgCode(
  camel?: string | null,
  snake?: string | null,
): string {
  return resolveGroupOrgCode(camel ?? snake ?? "");
}

/**
 * A supplier is a mirror-eligible SISTER group company when:
 *   • it is flagged as a group company (isGroupCompany truthy OR a non-empty
 *     group_org_code), AND
 *   • its resolved group org code names a company OTHER than the buying entity
 *     (default HOOKKA) — you don't mirror a PO you raised on yourself.
 *
 * When the supplier is flagged group but has no explicit group_org_code we fall
 * back to matching its NAME against the known group orgs (tolerant match), so a
 * legacy row flagged only via isGroupCompany still resolves. Returns the sister
 * org code (uppercase) or "" when not a mirror-eligible sister.
 */
export function resolveSupplierSisterOrg(args: {
  isGroupCompany: boolean;
  groupOrgCode?: string | null;
  supplierName?: string | null;
  /** Known group orgs to name-match against, e.g. [{code:"HOUZS", name:"Houzs Century"}]. */
  groupOrgs?: ReadonlyArray<{ code: string; name: string }>;
  /** The buying entity this PO is booked under (default HOOKKA). */
  buyerOrgCode?: string | null;
}): string {
  const buyer = resolveGroupOrgCode(args.buyerOrgCode) || DEFAULT_COMPANY_CODE;
  const explicit = resolveGroupOrgCode(args.groupOrgCode);
  if (!args.isGroupCompany && !explicit) return "";

  let code = explicit;
  if (!code && args.groupOrgs && args.groupOrgs.length > 0) {
    // Legacy row: flagged group but no code. Match the supplier NAME against
    // the known group orgs by normalized company name (Sdn Bhd tolerant).
    const target = normalizeCompanyName(args.supplierName);
    if (target) {
      let hit = "";
      let ambiguous = false;
      for (const o of args.groupOrgs) {
        if (normalizeCompanyName(o.name) === target) {
          if (hit) ambiguous = true;
          hit = o.code.trim().toUpperCase();
        }
      }
      if (!ambiguous) code = hit;
    }
  }
  if (!code) return "";
  // Don't mirror onto the buyer itself.
  if (code === buyer) return "";
  return code;
}

/**
 * The full mirror decision for a Purchase Order. Returns whether a mirror SO
 * should be created and, if so, under which sister company. Fires ONLY when:
 *   • the global auto-create-mirror config is ON;
 *   • the supplier resolves to a mirror-eligible SISTER org (see above), which
 *     already excludes the buyer entity — so a PO on yourself never mirrors.
 *
 * Pure: the caller supplies the config flag + the resolved supplier facts and
 * acts on the result (log-guard + INSERT). External POs (supplier not a group
 * company) always return { mirror:false } → byte-identical behaviour.
 */
export function decidePurchaseOrderMirror(args: {
  autoCreateMirrorDocs: boolean;
  purchaseOrgCode?: string | null;
  supplier: {
    isGroupCompany: boolean;
    groupOrgCode?: string | null;
    name?: string | null;
  };
  groupOrgs?: ReadonlyArray<{ code: string; name: string }>;
}):
  | { mirror: false }
  | { mirror: true; sisterOrgCode: string; buyerOrgCode: string } {
  if (!args.autoCreateMirrorDocs) return { mirror: false };
  const buyer =
    resolveGroupOrgCode(args.purchaseOrgCode) || DEFAULT_COMPANY_CODE;
  const sister = resolveSupplierSisterOrg({
    isGroupCompany: args.supplier.isGroupCompany,
    groupOrgCode: args.supplier.groupOrgCode,
    supplierName: args.supplier.name,
    groupOrgs: args.groupOrgs,
    buyerOrgCode: buyer,
  });
  if (!sister) return { mirror: false };
  return { mirror: true, sisterOrgCode: sister, buyerOrgCode: buyer };
}
