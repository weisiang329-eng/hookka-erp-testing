// ---------------------------------------------------------------------------
// customer-hint.ts — what `po_scan_samples.customerHint` is allowed to hold,
// and how to fold a stored hint back onto a real `customers` row.
//
// Owner report 2026-08-05:「为什么它会收到像 PO2068 这样的东西？非常奇怪」.
// The hint was captured as `fileName.split(/[-_ .]/)[0]` — the first token of
// whatever the operator named the file. A PO saved as "PO 2608-027.pdf" or
// "9752.pdf" therefore filed the PO NUMBER as the customer, and the accuracy
// dashboard grew rows called 'PO' (63), 'PO2608' (2) and '9752' (1). Worse,
// even a GOOD name was stored verbatim off the letterhead, so ONE customer
// split across several rows ('Houzs Century Sdn Bhd' 57 + 'Houzs Century' 3).
//
// Two rules, both pure so they are unit-tested (customer-hint.test.mjs) and
// shared by the capture side (routes/scan-po.ts, lib/scan-engine.ts) and the
// read side (routes/ocr-accuracy.ts):
//
//   1. CAPTURE — a value that is obviously a fragment of a PO number is not a
//      customer. Store NULL rather than pollute the dashboard with it.
//   2. READ — resolve a stored hint to the catalog customer it names before
//      grouping. Anything that resolves to nothing groups under ONE
//      'Unidentified' bucket, not one row per spelling.
//
// Deliberately NOT a data migration: existing prod rows are left exactly as
// they are and folded at read time.
// ---------------------------------------------------------------------------
import { normalizeCompanyName } from "./company-name-match";

/** The single bucket every unresolvable hint groups under on the dashboard. */
export const UNIDENTIFIED_CUSTOMER = "Unidentified";

// Document-number prefixes our operators actually type into file names. A
// customer name never looks like one of these followed by digits alone.
const DOC_PREFIX = /^(PO|POS|SO|DO|INV|GRN|PI|QT|REF)\d*$/;

/**
 * True when `raw` is plainly a piece of a document number rather than a party:
 * bare digits ("9752"), a bare prefix ("PO", "P/O"), or prefix+digits
 * ("PO2608", "PO-2608"). Punctuation and case are ignored before testing.
 */
export function isPoNumberFragment(raw: string | null | undefined): boolean {
  const s = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!s) return false;
  if (/^\d+$/.test(s)) return true;
  if (DOC_PREFIX.test(s)) return true;
  // A single letter carries no identity either ("P.pdf").
  return s.length < 2;
}

/**
 * Capture-side filter: the value to store in `customerHint`, or null when the
 * candidate is empty or is a PO-number fragment. Trims but never rewrites a
 * real name — the read side does the folding, so the raw letterhead spelling
 * stays available for forensics.
 */
export function cleanCustomerHint(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (isPoNumberFragment(s)) return null;
  return s.slice(0, 120);
}

/**
 * Read-side resolution: the ONE catalog customer a stored hint names, or null.
 *
 *   1. exact after normalisation (upper-case, drop SDN BHD / BERHAD / PLT and
 *      all punctuation) — folds 'Houzs Century Sdn Bhd' onto 'Houzs Century'
 *      and '2990 HOME SDN. BHD.' onto '2990 HOME SDN BHD';
 *   2. a UNIQUE prefix relationship in either direction, min 4 characters —
 *      folds the scanner's 'Carres Sdn. Bhd.' onto the record 'Carress'.
 *
 * Uniqueness-guarded like matchByCompanyName (reject-don't-guess): two
 * customers matching the same hint returns null, so an ambiguous hint lands in
 * 'Unidentified' instead of being credited to the wrong company. Step 2 is
 * looser than anything we allow on a WRITE path on purpose — this feeds a
 * read-only accuracy report, never a created order.
 */
export function resolveCustomerHint<T extends { name: string }>(
  customers: readonly T[],
  hint: string | null | undefined,
): T | null {
  const cleaned = cleanCustomerHint(hint);
  if (!cleaned) return null;
  const target = normalizeCompanyName(cleaned);
  if (!target) return null;

  let exact: T | null = null;
  for (const cst of customers) {
    if (normalizeCompanyName(cst.name) === target) {
      if (exact) return null; // ambiguous
      exact = cst;
    }
  }
  if (exact) return exact;

  if (target.length < 4) return null;
  let near: T | null = null;
  for (const cst of customers) {
    const n = normalizeCompanyName(cst.name);
    if (n.length < 4) continue;
    if (n.startsWith(target) || target.startsWith(n)) {
      if (near && near !== cst) return null; // ambiguous
      near = cst;
    }
  }
  return near;
}
