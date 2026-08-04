// ---------------------------------------------------------------------------
// supplier-material-candidates.ts — decide WHAT the OCR text is searched against.
//
// Owner 2026-08-04: "为什么第一次一定要手动 pick 呢？你明明就可以根据我的 OCR，去我
// 的 picker 里面去选… 他可以 manually pick，当错的时候，不过他一定要能自己找啊."
//
// The matcher was never the problem. The CANDIDATE SET was: it came from
// `supplier_material_bindings` alone, and a binding only exists after somebody
// has already picked that line by hand. So the first appearance of any item —
// the exact case the owner is complaining about — searched an empty list and
// fell straight through to a manual pick. Scoping to the supplier was right;
// scoping to *bindings* made it unreachable on the first pass.
//
// A supplier's materials are knowable long before any binding exists:
//
//   TIER 1  the linked PO's own lines. We wrote that order — it is a
//           declaration of exactly what this delivery should contain, and it
//           is there the very first time we buy from anyone.
//   TIER 2  everything ever ordered from this supplier (PO history) plus their
//           bindings. Small, specific, and earned from real transactions.
//   TIER 3  the whole active catalogue, at a deliberately higher bar. A new
//           supplier's first document still resolves when the wording is
//           unambiguous, instead of resolving nothing at all.
//
// The bar rises as the field widens, because the two mistakes cost different
// amounts. A blank line costs one pick — the owner explicitly accepts that
// ("他可以 manually pick，当错的时候"). A WRONG match books stock and cost
// against the wrong material and is found much later. So tier 3 must clear a
// noticeably higher score AND beat its runner-up by more, and every tier still
// refuses a near-tie rather than flipping a coin.
//
// Pure — no React, no DB — so the tiers and thresholds are directly testable.
// ---------------------------------------------------------------------------

import { matchCatalogItem, type CatalogItem, type TextMatch } from "./material-text-match";

export interface MaterialLike extends CatalogItem {
  itemCode: string;
  description?: string | null;
}

export interface PoItemLike {
  materialCode?: string | null;
  materialName?: string | null;
  supplierSKU?: string | null;
}

export interface PoLike {
  id: string;
  supplierId?: string | null;
  items?: PoItemLike[] | null;
}

export interface BindingLike {
  supplierId: string;
  materialCode: string;
  supplierSku?: string | null;
}

/** Where a candidate set came from — surfaced to the operator on the card. */
export type CandidateTier = "po" | "supplier" | "catalog";

export interface Tier<T> {
  tier: CandidateTier;
  items: T[];
  minScore?: number;
  minMargin?: number;
}

export interface Resolution<T> extends TextMatch<T> {
  tier: CandidateTier;
  /** "sku" when the supplier's own code matched exactly; "text" when read. */
  via: "sku" | "text";
}

/**
 * The catalogue-wide bar.
 *
 * Higher than the scoped tiers on both axes: with thousands of rows in play a
 * 0.5 score is a family resemblance, not an identification, and the runner-up
 * is usually a sibling that differs by exactly the token that matters.
 */
export const CATALOG_MIN_SCORE = 0.72;
export const CATALOG_MIN_MARGIN = 0.25;

/** Strip every non-alphanumeric char — OCR drift writes SL.27 / SL 27 / SL-27. */
export function normKey(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A supplier-code field that is really the document's line NUMBER.
 *
 * Owner 2026-08-04: "其他的供应商都没问题，就这个 ADD WOOD 有问题."
 *
 * ADD WOOD's invoice is `No | Description | Qty | Unit/Price | Amount` — they
 * print no product code at all, and the leading "No" column is a running 1, 2,
 * 3. The extractor sees a short per-line value in the leftmost column and fills
 * `supplierCode` with it, which is worse than leaving it null in three ways:
 * the description fallback is skipped (and the description is the ONLY
 * identifying text they print), the prefix-tolerant binding search matches any
 * SKU ending in that digit, and the digit becomes a high-weight token that
 * drags the text score down.
 *
 * The trade is deliberately one-sided. Rejecting a genuine 1–3 digit code costs
 * a fall-through to description and text matching, which now resolve well.
 * Accepting a row number binds the WRONG material, silently.
 */
export function looksLikeRowNumber(code: string | null | undefined): boolean {
  const t = (code ?? "").trim();
  if (!t) return false;
  // "1", "01", "12.", "3)" — a bare short integer with optional trailing
  // punctuation. Anything carrying a letter is a real code.
  return /^\d{1,3}\s*[.)]?$/.test(t);
}

/** The supplier's catalogue code on a line — "" when they printed none. */
export function supplierCodeOf(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  return looksLikeRowNumber(t) ? "" : t;
}

/**
 * Shortest supplier SKU that may be matched by SUFFIX rather than exactly.
 *
 * The prefix-tolerant search exists for real drift ("OST- SL 27" vs "SL.27"),
 * but with a two-character key it matches almost anything and binds silently.
 */
export const MIN_SKU_SUFFIX_MATCH = 3;

/**
 * Index a catalogue by code the way this module looks codes up.
 *
 * Callers must build the map with this rather than their own uppercase-trim
 * index: `normKey` strips punctuation, so a map keyed "PLY-9-48-AB" would miss
 * every lookup here and silently produce empty candidate sets.
 */
export function indexByCode<T extends MaterialLike>(materials: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const rm of materials) {
    const k = normKey(rm.itemCode);
    if (k && !m.has(k)) m.set(k, rm);
  }
  return m;
}

function dedupe<T extends MaterialLike>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = normKey(it.itemCode);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function lookup<T extends MaterialLike>(
  codes: Iterable<string>,
  materialByCode: Map<string, T>,
): T[] {
  const out: T[] = [];
  for (const c of codes) {
    const hit = materialByCode.get(normKey(c));
    if (hit) out.push(hit);
  }
  return dedupe(out);
}

/**
 * Materials named on the purchase order(s) this document links to.
 *
 * Plural because a supplier bills or delivers against several of our orders on
 * one document ("P/O No : 2607-003/2607-020") and that is ONE receipt — every
 * order it names is equally part of what should have turned up.
 */
export function materialsOnPo<T extends MaterialLike>(
  pos: PoLike | PoLike[] | null | undefined,
  materialByCode: Map<string, T>,
): T[] {
  const list = pos == null ? [] : Array.isArray(pos) ? pos : [pos];
  const codes: string[] = [];
  for (const po of list) {
    if (!po || !Array.isArray(po.items)) continue;
    for (const i of po.items) {
      const c = (i.materialCode ?? "").trim();
      if (c) codes.push(c);
    }
  }
  return lookup(codes, materialByCode);
}

/**
 * Everything this supplier has ever been asked to deliver, from PO history and
 * from bindings. PO history matters most: it exists from the first order,
 * whereas a binding only appears after somebody has already done the pick by
 * hand — which is the very step we are trying to remove.
 */
export function materialsEverBought<T extends MaterialLike>(
  supplierId: string,
  purchaseOrders: PoLike[],
  bindings: BindingLike[],
  materialByCode: Map<string, T>,
): T[] {
  if (!supplierId) return [];
  const codes: string[] = [];
  for (const po of purchaseOrders) {
    if ((po.supplierId ?? "") !== supplierId || !Array.isArray(po.items)) continue;
    for (const it of po.items) {
      const c = (it.materialCode ?? "").trim();
      if (c) codes.push(c);
    }
  }
  for (const b of bindings) {
    if (b.supplierId !== supplierId) continue;
    const c = (b.materialCode ?? "").trim();
    if (c) codes.push(c);
  }
  return lookup(codes, materialByCode);
}

/**
 * The supplier's OWN codes → our material, learned from PO lines.
 *
 * A PO records the supplier's SKU next to our material code, so when their
 * document prints that same code there is nothing to infer — it is a lookup,
 * not a match, and it beats any amount of text scoring. Keys that point at two
 * different materials are dropped: an ambiguous code must not silently pick.
 */
export function supplierSkuIndex<T extends MaterialLike>(
  supplierId: string,
  purchaseOrders: PoLike[],
  bindings: BindingLike[],
  materialByCode: Map<string, T>,
): Map<string, T> {
  const codeByKey = new Map<string, string>();
  const conflicted = new Set<string>();
  const note = (sku: string | null | undefined, code: string | null | undefined) => {
    const k = normKey(sku);
    const c = normKey(code);
    if (!k || !c) return;
    const prev = codeByKey.get(k);
    if (prev && prev !== c) conflicted.add(k);
    else codeByKey.set(k, c);
  };
  for (const po of purchaseOrders) {
    if ((po.supplierId ?? "") !== supplierId || !Array.isArray(po.items)) continue;
    for (const it of po.items) note(it.supplierSKU, it.materialCode);
  }
  for (const b of bindings) {
    if (b.supplierId !== supplierId) continue;
    note(b.supplierSku, b.materialCode);
  }
  const out = new Map<string, T>();
  for (const [k, c] of codeByKey) {
    if (conflicted.has(k)) continue;
    const hit = materialByCode.get(c);
    if (hit) out.set(k, hit);
  }
  return out;
}

export interface TierInput<T extends MaterialLike> {
  supplierId: string;
  /** The PO(s) this document links to — a document may name several. */
  linkedPo?: PoLike | PoLike[] | null;
  purchaseOrders: PoLike[];
  bindings: BindingLike[];
  /** Built with `indexByCode` — a plain uppercase index will miss everything. */
  materialByCode: Map<string, T>;
  /** Whole active catalogue — the last resort. */
  catalog: T[];
}

/**
 * Narrowest, most-trusted search space first.
 *
 * Empty tiers are dropped so a caller can tell "nothing to search" from
 * "searched and found nothing".
 */
export function buildCandidateTiers<T extends MaterialLike>(input: TierInput<T>): Tier<T>[] {
  const tiers: Tier<T>[] = [];

  const onPo = materialsOnPo(input.linkedPo, input.materialByCode);
  if (onPo.length > 0) tiers.push({ tier: "po", items: onPo });

  const known = materialsEverBought(
    input.supplierId,
    input.purchaseOrders,
    input.bindings,
    input.materialByCode,
  );
  // Skip when the PO tier already covers it — re-searching the same rows at the
  // same bar cannot change the answer, and a "supplier" label would misreport
  // where the match actually came from.
  const onPoCodes = new Set(onPo.map((m) => normKey(m.itemCode)));
  const extra = known.filter((m) => !onPoCodes.has(normKey(m.itemCode)));
  if (extra.length > 0) tiers.push({ tier: "supplier", items: known });

  if (input.catalog.length > 0) {
    tiers.push({
      tier: "catalog",
      items: input.catalog,
      minScore: CATALOG_MIN_SCORE,
      minMargin: CATALOG_MIN_MARGIN,
    });
  }
  return tiers;
}

/**
 * Resolve one scanned line: exact supplier code first, then read the text
 * against each tier until one answers confidently.
 *
 * Returns null when no tier is sure — the operator picks, and (per the owner)
 * can always correct a match that is wrong. The point is that a blank line
 * should now be the exception rather than the default.
 */
export function resolveMaterialForLine<T extends MaterialLike>(
  text: string,
  tiers: Tier<T>[],
  opts: { supplierSku?: string | null; skuIndex?: Map<string, T> } = {},
): Resolution<T> | null {
  // A row number from the document's "No." column is not a code to look up.
  const skuKey = normKey(supplierCodeOf(opts.supplierSku));
  if (skuKey && opts.skuIndex) {
    const hit = opts.skuIndex.get(skuKey);
    if (hit) return { item: hit, score: 1, margin: 1, tier: "supplier", via: "sku" };
  }
  if (!text.trim()) return null;
  for (const t of tiers) {
    if (t.items.length === 0) continue;
    const hit = matchCatalogItem(text, t.items, {
      minScore: t.minScore,
      minMargin: t.minMargin,
    });
    if (hit) return { ...hit, tier: t.tier, via: "text" };
  }
  return null;
}
