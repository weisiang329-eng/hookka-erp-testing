// ---------------------------------------------------------------------------
// packing-card-resolve.ts — THE single, tolerant narrowing of a PO's PACKING
// job cards down to the ONE card a short box label refers to.
//
// A bedframe PO has MULTIPLE PACKING cards (one per compartment: Divan,
// Headboard, …), each with its own wipLabel. The printed sticker / scan carries
// a SHORT box label ("HB", "Divan", a fabric name) that must resolve to exactly
// ONE of those cards so a rack write lands on the right piece. A single-
// compartment PO has exactly one PACKING card and resolves trivially.
//
// This helper UNIFIES the narrowing that previously lived (duplicated) inline in
// three places — the authed mint endpoint, the public-rack-qr resolver, and the
// worker scanner — so they can never drift, AND it ADDS tolerant earlier match
// tiers (exact, then word-token) that run BEFORE the historical substring tier.
//
// ── NON-BREAKING CONTRACT (the owner has been burned by scanner regressions) ──
//   • Single-compartment PO (<= 1 PACKING card): return that card unchanged —
//     byte-identical to today (the old `cards.length === 1` fallback).
//   • The historical SUBSTRING + sole-card behaviour is the FINAL fallback tier,
//     so every PO that resolves today resolves IDENTICALLY. The new exact /
//     word-token tiers only run EARLIER and only rescue cases the substring tier
//     fails today (collisions, completed-vs-open ambiguity). They never change a
//     PO that already resolved uniquely via substring.
//   • No unique pick → return null (matches today's "skip / fall through").
// ---------------------------------------------------------------------------

export type PackingCard = {
  id: string;
  wipLabel: string | null;
  status: string | null;
};

// Upper-cased, trimmed label for tolerant comparison. Mirrors the historical
// `.toUpperCase()` comparison the inline narrowers used.
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

// A card is "open" (still rackable / not finished) unless its status is one of
// the terminal packing states. We prefer open cards within a tier so a re-print
// of a label shared by a finished + an in-flight piece lands on the live one.
function isOpen(card: PackingCard): boolean {
  const s = norm(card.status);
  return s !== "COMPLETED" && s !== "TRANSFERRED";
}

// Pick the single card a tier resolves to, preferring open cards:
//   • exactly one OPEN card in the tier → that card;
//   • else exactly one card in the tier (regardless of status) → that card;
//   • else ambiguous → null (caller decides whether to try a looser tier).
function pickFromTier(tier: PackingCard[]): PackingCard | null {
  if (tier.length === 0) return null;
  const open = tier.filter(isOpen);
  if (open.length === 1) return open[0];
  if (tier.length === 1) return tier[0];
  return null;
}

/**
 * Narrow a PO's PACKING cards to the one the box label `pieceName` refers to.
 *
 * Returns the matched card, or null when no unique card resolves (caller then
 * skips — the historical behaviour). NEVER returns a wrong card: an ambiguous
 * tier yields null rather than guessing.
 */
export function pickPackingCard(
  cards: PackingCard[],
  pieceName: string,
): PackingCard | null {
  // Single-compartment (or empty) PO — UNCHANGED from the old
  // `cards.length === 1` fallback. No label needed; there is only one card.
  if (cards.length <= 1) return cards[0] ?? null;

  const want = norm(pieceName);
  // No box label on a multi-card PO: there is nothing to narrow by, and the old
  // code only fell back to the sole card when there was exactly one. With >1
  // cards and no label there is no unique pick → null (matches today).
  if (!want) return null;

  // Match tiers, tightest first. (a) exact label; (b) word-token (the label is
  // its own alphanumeric token within the wipLabel); (c) substring — the
  // CURRENT behaviour, kept as the final fallback.
  const exact = cards.filter((c) => norm(c.wipLabel) === want);
  const wordToken = cards.filter((c) =>
    norm(c.wipLabel)
      .split(/[^A-Z0-9]+/)
      .filter(Boolean)
      .includes(want),
  );
  const substring = cards.filter((c) => norm(c.wipLabel).includes(want));

  // The exact tier is authoritative: if it matches at all, we resolve here.
  // If it is itself AMBIGUOUS (>1 exact, none uniquely open), we return null —
  // we must NOT silently fall through to a looser tier and risk a wrong card
  // when the precise label already collides.
  if (exact.length > 0) return pickFromTier(exact);

  // No exact match → try the looser tiers in order. Each looser tier only runs
  // because the tighter ones were EMPTY (not merely ambiguous), so this only
  // ever rescues cases the substring tier handles today, plus the new word-
  // token tier rescues collisions the substring tier would have called
  // ambiguous.
  const word = pickFromTier(wordToken);
  if (word) return word;

  // Final fallback — the historical substring + sole-card-of-tier behaviour.
  return pickFromTier(substring);
}
