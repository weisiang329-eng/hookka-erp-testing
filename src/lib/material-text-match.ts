// ---------------------------------------------------------------------------
// material-text-match.ts — match a supplier's own wording to our catalogue.
//
// Owner 2026-08-04: "为什么要手动 pick 呢？不是正常每一次 OCR 都是从我的 pick
// 里面选吗？那如果我要手动 pick 的话，还是 OCR 吗？"
//
// A fair complaint. The scanner only ever resolved a line through a saved
// supplier BINDING, so the first time an item appeared someone had to pick it
// by hand — even though the OCR had plainly read "9MM 4' X 8' PLYWOOD AB" and
// the catalogue contains that plywood. The reading was fine; nothing tried to
// use it.
//
// This matches the read text against the material catalogue directly. The bar
// is deliberately high, because the cost of the two mistakes is not symmetric:
// leaving a line blank costs one pick, while binding the WRONG material books
// stock and cost against the wrong item and is discovered much later. So a
// match is returned only when it is both strong AND clearly better than the
// runner-up; everything else returns null and the operator picks.
//
// Pure — no React, no DB — so the thresholds can be tested directly.
// ---------------------------------------------------------------------------

export interface CatalogItem {
  itemCode: string;
  description?: string | null;
}

export interface TextMatch<T> {
  item: T;
  /** 0-1 similarity of the winning candidate. */
  score: number;
  /** How far clear of the runner-up it was. 1 when it was the only candidate. */
  margin: number;
}

/** Minimum similarity before a match is offered at all. */
export const MIN_SCORE = 0.5;
/** The winner must beat the runner-up by this much, or the line is ambiguous. */
export const MIN_MARGIN = 0.12;

/**
 * Split text into comparable tokens.
 *
 * Supplier and catalogue wording differ mostly in punctuation and ordering —
 * `9MM 4' X 8' PLYWOOD AB` versus `PLYWOOD 9MM 4X8 AB`. Feet marks and a
 * standalone dimension "X" carry no meaning here, and gluing digit groups back
 * together lets `4' X 8'` and `4X8` land on the same token.
 */
export function tokenize(text: string): string[] {
  const cleaned = (text || "")
    .toUpperCase()
    .replace(/["'â€™]/g, "") // feet / inch marks
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];
  const raw = cleaned.split(" ").filter(Boolean);
  // Fold "4 X 8" into "4X8" so a dimension written either way matches.
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (
      raw[i + 1] === "X" &&
      raw[i + 2] &&
      /^\d+$/.test(raw[i]) &&
      /^\d+$/.test(raw[i + 2])
    ) {
      out.push(`${raw[i]}X${raw[i + 2]}`);
      i += 2;
      continue;
    }
    out.push(raw[i]);
  }
  return out;
}

/** Shared tokens required before CONTAINMENT is allowed to carry a match. */
export const MIN_SHARED_TOKENS = 2;

/**
 * How well the supplier's wording matches a catalogue entry.
 *
 * Two readings, best one wins:
 *
 *   • JACCARD — shared ÷ union. Right when both sides describe the item at the
 *     same level of detail.
 *   • CONTAINMENT — how much of the SUPPLIER's wording appears in the
 *     catalogue entry. Necessary because our catalogue is usually the more
 *     verbose side ("PLYWOOD SHEET AB GRADE 9MM 4FT X 8FT" against the
 *     supplier's "9MM 4' X 8' PLYWOOD AB"), and Jaccard punishes every extra
 *     word we happen to record. Judged on Jaccard alone that pair scores 0.33
 *     and the operator is sent to pick a line the text plainly identifies.
 *
 * Containment is gated on MIN_SHARED_TOKENS, because a single shared word
 * ("PLYWOOD") would otherwise "fully contain" a one-word line and match
 * everything in that family.
 */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  if (shared < MIN_SHARED_TOKENS) return jaccard;
  const containment = shared / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

/**
 * Best catalogue match for a supplier's line text, or null when the answer is
 * not clear enough to act on.
 *
 * Returns null rather than a guess when the top two candidates are close: an
 * ambiguous line is exactly the case where an automatic choice books against
 * the wrong material, and a human pick costs seconds.
 */
/** A size-like token: `4X8`, `1220X2440`, `9MM`, `2INCH`, `28`. */
function isDimensionToken(t: string): boolean {
  return /^\d/.test(t);
}

/**
 * Tokens that distinguish the candidates from each other.
 *
 * A word every candidate shares carries no information — every plywood row
 * says PLYWOOD — while the size the supplier always prints is precisely what
 * separates a 4X8 board from a 4X6 one. Weighting by rarity puts the decision
 * where the evidence actually is, instead of letting three shared words drown
 * out the one that matters.
 */
function discriminatingWeights(candidates: string[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const c of candidates) {
    for (const t of new Set(tokenize(c))) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, candidates.length);
  const w = new Map<string, number>();
  for (const [t, df] of docFreq) {
    // 1 when the token appears in a single candidate, → 0 when it is in all.
    w.set(t, Math.log((n + 1) / (df + 0.5)) / Math.log(n + 1));
  }
  return w;
}

/** Weighted overlap of the supplier's tokens against one candidate. */
function weightedScore(text: string, candidate: string, w: Map<string, number>): number {
  const ta = tokenize(text);
  const tb = new Set(tokenize(candidate));
  if (ta.length === 0 || tb.size === 0) return 0;
  let hit = 0;
  let total = 0;
  for (const t of new Set(ta)) {
    const weight = (w.get(t) ?? 1) + 0.15; // floor so a shared word still counts a little
    total += weight;
    if (tb.has(t)) hit += weight;
  }
  if (total === 0) return 0;
  let score = hit / total;

  // A stated size that CONTRADICTS the candidate is evidence against, not
  // merely absent evidence. The supplier always prints the size, so a mismatch
  // means this is a different board.
  const supplierDims = [...new Set(ta)].filter(isDimensionToken);
  const candDims = [...tb].filter(isDimensionToken);
  if (supplierDims.length > 0 && candDims.length > 0) {
    const agreed = supplierDims.filter((d) => tb.has(d)).length;
    if (agreed === 0) score *= 0.4;
  }
  return score;
}

export function matchCatalogItem<T extends CatalogItem>(
  text: string,
  catalog: T[],
  opts: { minScore?: number; minMargin?: number } = {},
): TextMatch<T> | null {
  const minScore = opts.minScore ?? MIN_SCORE;
  const minMargin = opts.minMargin ?? MIN_MARGIN;
  if (!text.trim() || catalog.length === 0) return null;

  // Weights come from THIS candidate set — what distinguishes two boards from
  // one supplier is not what distinguishes the whole catalogue.
  const corpus = catalog.flatMap((i) => [i.description ?? "", i.itemCode]).filter(Boolean);
  const weights = discriminatingWeights(corpus);

  const scored = catalog
    .map((item) => ({
      item,
      // An item's own code is often what a supplier prints, so score against
      // both the description and the code and keep the better reading. Plain
      // similarity is kept as a floor for the single-candidate case, where
      // there is nothing to discriminate against.
      score: Math.max(
        weightedScore(text, item.description ?? "", weights),
        weightedScore(text, item.itemCode, weights),
        catalog.length === 1
          ? Math.max(similarity(text, item.description ?? ""), similarity(text, item.itemCode))
          : 0,
      ),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  const best = scored[0];
  if (best.score < minScore) return null;

  const runnerUp = scored[1]?.score ?? 0;
  const margin = best.score - runnerUp;
  if (scored.length > 1 && margin < minMargin) return null;

  return { item: best.item, score: best.score, margin: scored.length > 1 ? margin : 1 };
}
