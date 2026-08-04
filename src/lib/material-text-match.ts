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

/** Jaccard similarity of two token sets — order-independent by design. */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Best catalogue match for a supplier's line text, or null when the answer is
 * not clear enough to act on.
 *
 * Returns null rather than a guess when the top two candidates are close: an
 * ambiguous line is exactly the case where an automatic choice books against
 * the wrong material, and a human pick costs seconds.
 */
export function matchCatalogItem<T extends CatalogItem>(
  text: string,
  catalog: T[],
  opts: { minScore?: number; minMargin?: number } = {},
): TextMatch<T> | null {
  const minScore = opts.minScore ?? MIN_SCORE;
  const minMargin = opts.minMargin ?? MIN_MARGIN;
  if (!text.trim() || catalog.length === 0) return null;

  const scored = catalog
    .map((item) => ({
      item,
      // An item's own code is often what a supplier prints, so score against
      // both the description and the code and keep the better reading.
      score: Math.max(similarity(text, item.description ?? ""), similarity(text, item.itemCode)),
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
