// ---------------------------------------------------------------------------
// scan-party-resolve.ts — ONE resolver for a scanned customer PO's customer +
// delivery hub. Owner 2026-08-01: 「picker 显示什么，建出来就该是什么」.
//
// Why this exists
// ---------------
// scan-po-modal used to carry THREE separate copies of the same tolerant match:
// the create path (the only one that persisted), the customer <select>, and a
// hub reverse-lookup. The customer picker's result lived in a render-local
// `matchId` that was never written back to state, so `po.customerId` stayed
// null even while the dropdown displayed the right company.
//
// The hub picker was the ONLY consumer reading raw `po.customerId`. It saw
// null → "this customer has no hubs" → the <select> never rendered → it fell
// back to a plain text badge showing the OCR'd hub name. `deliveryHubId` was
// therefore never set and every scanned Houzs SO was created hub-less while
// the preview looked entirely correct (9 SOs in one batch, 2026-08-01).
//
// Routing the pickers, the pre-create hub gate and the create payload through
// this one function makes "what you see" and "what gets created" the same
// value by construction, rather than three code paths that happen to agree.
//
// Precedence, for both fields: an EXPLICIT operator pick always wins — the
// resolver checks the incoming id first and returns it untouched, so choosing
// a customer / hub by hand is never overridden on the next render.
//
// Pure + dependency-free so it's unit-tested (scan-party-resolve.test.mjs) and
// reusable from the backend (scan-po validateAndEnrichPO) later.
// ---------------------------------------------------------------------------
import { matchByCompanyName } from "./company-name-match";

export type CatalogHub = { id: string; shortName: string; state: string | null };

export type CatalogCustomer = {
  id: string;
  name: string;
  hubs: CatalogHub[];
};

export type ScannedParty = {
  customerId?: string | null;
  customerName?: string | null;
  /** Hub name as OCR read it off the document, e.g. "Houzs KL". */
  deliveryHub?: string | null;
  deliveryHubId?: string | null;
};

export type ResolvedParty = {
  customerId: string | null;
  /** The resolved customer's hubs; empty when no customer resolved. */
  hubs: CatalogHub[];
  hubId: string | null;
};

/**
 * Uppercase + strip every non-alphanumeric.
 * "Houzs KL" / "houzs-kl" / "HOUZS  KL" → "HOUZSKL".
 *
 * Deliberately NOT normalizeCompanyName: a hub short name is our own label,
 * not a legal entity — it has no Sdn Bhd suffix to strip, and stripping trade
 * words could collide two real hubs.
 */
export function normalizeHubName(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * Resolve the catalog customer and delivery hub for one scanned PO.
 *
 * Customer: explicit id → tolerant legal-name match (ignores Sdn Bhd) → the
 * unique customer that owns a hub with the name printed on the PO.
 * Hub: explicit id → the PO's hub name matched against that customer's hubs.
 *
 * Both lookups are unique-guarded: an ambiguous match resolves to null so the
 * operator picks manually, never a silent wrong company.
 */
export function resolveScanParty(
  customers: readonly CatalogCustomer[] | null | undefined,
  po: ScannedParty,
): ResolvedParty {
  let customerId = po.customerId ?? null;
  if (!customerId && customers && customers.length > 0) {
    let hit = matchByCompanyName(customers, po.customerName ?? "");
    if (!hit && po.deliveryHub) {
      const target = normalizeHubName(po.deliveryHub);
      if (target) {
        const byHub = customers.filter((c) =>
          c.hubs.some((h) => normalizeHubName(h.shortName) === target),
        );
        if (byHub.length === 1) hit = byHub[0];
      }
    }
    if (hit) customerId = hit.id;
  }

  const hubs = customerId
    ? (customers?.find((c) => c.id === customerId)?.hubs ?? [])
    : [];

  let hubId = po.deliveryHubId ?? null;
  if (!hubId && po.deliveryHub && hubs.length > 0) {
    const target = normalizeHubName(po.deliveryHub);
    if (target) {
      hubId = hubs.find((h) => normalizeHubName(h.shortName) === target)?.id ?? null;
    }
  }

  return { customerId, hubs, hubId };
}
