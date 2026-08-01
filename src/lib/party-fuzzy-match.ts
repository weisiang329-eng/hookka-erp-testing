// ---------------------------------------------------------------------------
// party-fuzzy-match.ts — rank catalog parties by how closely their name matches
// what OCR read, instead of giving up when nothing matches exactly.
//
// Owner 2026-08-01: 「不管有没有 sdnbhd，他去 picker 找到最像的都可以用啊」 and,
// on marking the guess: 「不需要表明猜的啊，对我们就会 confirm，不对就会人为改动」.
// So: pre-select the best candidate silently. No "guessed" badge.
//
// Why exact matching wasn't enough (measured, not assumed)
// -------------------------------------------------------
// Supplier 400-A002's master record read "ADD WOORD TRADING SDN. BHD." — a
// one-letter typo against the invoice's "ADD WOOD TRADING SDN BHD". Run over
// the real 38-supplier list:
//
//   pickSupplierFromName   exact 0 · normalised 0 · prefix/suffix 0  → null
//   matchByCompanyName     0                                         → null
//   edit distance          best = 1, runner-up = 8
//
// Both exact-ish matchers returned nothing, so unifying them would have changed
// nothing. Only ranking crosses a typo in the master data — and with an 8×
// separation there was never a real risk of picking the wrong company.
//
// The safety rail is that separation. `bestMatch` returns a candidate only when
// it is clearly ahead of the runner-up; when the top two are close it returns
// null and the operator picks, because a coin-flip pre-selection is worse than
// a blank — it looks decided and slips past a quick confirm.
// ---------------------------------------------------------------------------
import { normalizeCompanyName } from "./company-name-match";

export type FuzzyCandidate<T> = {
  party: T;
  /** Levenshtein distance on the normalised names. 0 = identical. */
  distance: number;
  /** 0..1, 1 = identical. distance relative to the longer name. */
  score: number;
};

/** Levenshtein distance, two-row rolling buffer. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Rank every party against `rawName`, closest first.
 * Names are normalised (legal suffix + punctuation stripped) before comparing,
 * so "X Sdn Bhd" and "X" are already identical at distance 0.
 */
export function rankPartiesByName<T extends { name: string }>(
  parties: readonly T[],
  rawName: string | null | undefined,
): FuzzyCandidate<T>[] {
  const target = normalizeCompanyName(rawName);
  if (!target) return [];
  return parties
    .map((party) => {
      const cand = normalizeCompanyName(party.name);
      const distance = cand ? editDistance(cand, target) : Number.MAX_SAFE_INTEGER;
      const longest = Math.max(cand.length, target.length) || 1;
      return {
        party,
        distance,
        score: distance >= longest ? 0 : 1 - distance / longest,
      };
    })
    .filter((c) => c.distance !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.distance - b.distance || a.party.name.localeCompare(b.party.name));
}

export type BestMatchOptions = {
  /**
   * Reject anything below this similarity. 0.8 tolerates ~1 typo in a 5-char
   * word and ~4 in a 20-char company name, while still refusing two genuinely
   * different companies that happen to share a prefix.
   */
  minScore?: number;
  /**
   * The winner must beat the runner-up by at least this many edits. 2 means a
   * near-tie (ADD WOOD vs ADD WOODS, both distance 1) yields null rather than a
   * coin flip. The ADD WOORD case cleared this easily: 1 vs 8.
   */
  minLead?: number;
};

/**
 * The single best candidate, or null when nothing is close enough / the top two
 * are too close to call. Callers pre-select the result and leave the picker
 * open for the operator to override.
 */
export function bestMatch<T extends { name: string }>(
  parties: readonly T[],
  rawName: string | null | undefined,
  opts: BestMatchOptions = {},
): { party: T; distance: number; score: number } | null {
  const { minScore = 0.8, minLead = 2 } = opts;
  const ranked = rankPartiesByName(parties, rawName);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  if (top.score < minScore) return null;
  // An exact normalised hit needs no lead — it IS the answer.
  if (top.distance === 0) {
    // ...unless two parties normalise identically, which is unresolvable.
    if (ranked[1]?.distance === 0) return null;
    return top;
  }
  const runnerUp = ranked[1];
  if (runnerUp && runnerUp.distance - top.distance < minLead) return null;
  return top;
}
