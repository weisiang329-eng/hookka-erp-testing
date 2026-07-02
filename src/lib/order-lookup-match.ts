// Tolerant resolver for the "Copy from Sales / Consignment Order" lookup
// (sales/create.tsx CopyFromSourceModal). Operators type the order number
// WITHOUT our document-type prefix — "2605-001" for "SO-2605-001" — and the
// old exact-equality match forced them to type the full "SO-2605-001", so a
// bare "2605-001" resolved to nothing (Wei Siang 2026-07-02: "why must I type
// the full number?").
//
// The fix strips a leading SO-/CO-/SV- prefix from BOTH the stored id and the
// typed value before comparing OUR ids, so either form resolves. Our ids are
// unique on the number alone (SO-YYMM-NNN), so prefix-stripping can never
// create a NEW collision — and if a bare number legitimately matches two of
// our docs (e.g. an SO and an SV sharing 2605-001), the caller's existing
// multi-match chooser lets the operator pick. Customer PO / customer SO /
// reference stay EXACT — those are the customer's own arbitrary strings and
// must not be prefix-mangled.

export type OrderLookupCandidate = {
  id: string;
  companySOId?: string | null;
  companyCOId?: string | null;
  customerPOId?: string | null;
  customerSO?: string | null;
  customerSOId?: string | null;
  reference?: string | null;
  customerName?: string | null;
};

const norm = (s?: string | null) => (s ?? "").trim().toUpperCase();
// Strip one leading doc-type prefix ("SO-", "CO-", "SV-", with or without the
// dash) from an already-normalized (upper/trimmed) string.
const stripDoc = (s: string) => s.replace(/^(SO|CO|SV)-?/, "");

// Which field of a candidate the typed value matched, or null. `target` may be
// raw or pre-normalized — it is normalized here either way.
export function matchedOrderField(
  r: OrderLookupCandidate,
  sourceType: "SO" | "CO",
  target: string,
): string | null {
  const t = norm(target);
  if (t === "") return null;
  // OUR ids: prefix-tolerant (exact, or equal once both sides drop SO-/CO-/SV-).
  const idEq = (stored?: string | null): boolean => {
    const a = norm(stored);
    return a !== "" && (a === t || stripDoc(a) === stripDoc(t));
  };
  if (sourceType === "CO") {
    if (idEq(r.companyCOId)) return "our CO";
    if (norm(r.reference) === t) return "reference";
    return null;
  }
  if (idEq(r.companySOId)) return "our SO";
  if (norm(r.customerPOId) === t) return "customer PO";
  if (norm(r.customerSO) === t || norm(r.customerSOId) === t) return "customer SO";
  if (norm(r.reference) === t) return "reference";
  return null;
}
