// ---------------------------------------------------------------------------
// po-ref-match.ts — resolve the PO reference(s) printed on a supplier document.
//
// Suppliers routinely bill several purchase orders on one invoice and separate
// the numbers however they like. ADD WOOD prints:
//
//     P/O No : 2607-003/2607-020
//
// The original matcher normalised that whole string to "26070032607020" and
// then tested `ref.endsWith(poNo)` — which is TRUE for the LAST number in the
// list. It linked 2607-020 and silently dropped 2607-003. That is worse than
// not linking at all: the invoice then looks fully reconciled while the first
// PO's receipts are never drawn down against it.
//
// So: split first, match each reference on its own, and refuse to guess when
// the document names more than one PO. A Purchase Invoice carries a single
// purchaseOrderId and cannot represent such a document truthfully, so the
// honest move is to hand the decision back rather than hide half of it.
//
// Pure — no React, no DB — so the matching rules are testable on their own.
// ---------------------------------------------------------------------------

/** The minimum a caller must provide for matching. */
export interface PoLike {
  id: string;
  poNo?: string | null;
}

/** Strip everything that varies between how a code is written. */
function norm(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Split one printed PO field into the individual references it names.
 * Handles "/", ",", ";", "|", "&", newlines and the word "and".
 */
export function splitPoRefs(raw: string): string[] {
  return (raw || "")
    .split(/[/,;|&\n]+|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Match ONE printed reference against the known POs.
 *
 * Returns a PO only when exactly one candidate qualifies — two candidates for
 * a single printed reference is precisely the case where guessing goes wrong
 * quietly, so it resolves to nothing instead.
 */
export function matchOnePoRef<T extends PoLike>(ref: string, pos: T[]): T | null {
  const n = norm(ref);
  if (!n) return null;
  const hits = pos.filter((p) => {
    const poNo = norm(p.poNo);
    return poNo && (poNo === n || poNo.endsWith(n) || n.endsWith(poNo));
  });
  return hits.length === 1 ? hits[0] : null;
}

export interface PoLinkResult {
  /** The PO to link, or null when it cannot be decided automatically. */
  poId: string | null;
  /** Every PO reference on the document that resolved to a known PO. */
  matchedPoIds: string[];
  /** References printed on the document that matched no known PO. */
  unmatchedRefs: string[];
  /** True when the document names more than one PO — a human must choose. */
  ambiguous: boolean;
}

/**
 * Resolve a document's PO reference field.
 *
 * One resolved PO links automatically. Two or more and NOTHING is linked, with
 * `matchedPoIds` handed back so the caller can show what the document actually
 * named. Zero falls back to whatever the host already had selected.
 */
export function resolvePoLink<T extends PoLike>(
  rawRef: string | null | undefined,
  pos: T[],
  fallback: string | null | undefined,
): PoLinkResult {
  const refs = splitPoRefs((rawRef ?? "").trim());
  const matchedPoIds: string[] = [];
  const unmatchedRefs: string[] = [];
  for (const r of refs) {
    const hit = matchOnePoRef(r, pos);
    if (hit) {
      if (!matchedPoIds.includes(hit.id)) matchedPoIds.push(hit.id);
    } else {
      unmatchedRefs.push(r);
    }
  }
  if (matchedPoIds.length === 1) {
    return { poId: matchedPoIds[0], matchedPoIds, unmatchedRefs, ambiguous: false };
  }
  if (matchedPoIds.length > 1) {
    return { poId: null, matchedPoIds, unmatchedRefs, ambiguous: true };
  }
  return { poId: fallback ?? null, matchedPoIds, unmatchedRefs, ambiguous: false };
}
