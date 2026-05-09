// ---------------------------------------------------------------------------
// PO ↔ SO line item alignment validator (multiset-based).
//
// Background: SO-2605-027 surfaced a generator bug where multi-line same-
// productCode + qty>1 SOs produced production_orders whose attributes
// (productCode, sizeLabel, sizeCode, fabricCode, divanHeightInches, etc.)
// got SHUFFLED across SO lines.
//
// Schema reality: production_orders has NO salesOrderItemId FK column —
// only salesOrderId (one-to-many). We can't trace each PO back to its
// source SO line by explicit linkage. So this validator uses multiset
// comparison: build the expected (attribute-tuple × quantity) bag from
// sales_order_items, build the actual bag from production_orders, diff.
//
// A clean SO will have identical bags. A shuffled SO will have bags that
// differ — surfacing the exact (over-represented / missing) tuples so the
// operator can pinpoint the corruption.
//
// Two use cases:
//   (a) On-demand audit endpoint (read-only).
//   (b) Defense-in-depth in SO confirm path: warn-only, surfaces in the
//       response so the operator notices BEFORE production starts on a
//       corrupt batch.
// ---------------------------------------------------------------------------

export type SoLineItem = {
  id: string;
  lineNo: number | null;
  lineSuffix: string | null;
  productCode: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  quantity: number;
};

export type ProductionOrderRow = {
  id: string;
  poNo: string;
  productCode: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  quantity: number;
};

export type AttributeTuple = {
  productCode: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
};

export type BagDiff = {
  tuple: AttributeTuple;
  expectedCount: number;
  actualCount: number;
  delta: number; // actual - expected; positive = surplus, negative = missing
};

export type ValidationResult = {
  ok: boolean;
  expectedPoCount: number;
  actualPoCount: number;
  /**
   * Tuples that appear MORE often in production_orders than expected from
   * sales_order_items. Indicates attribute-shuffle (some SO line's tuple
   * was used for an extra PO at another line's expense).
   */
  surplusTuples: BagDiff[];
  /**
   * Tuples expected from sales_order_items that don't appear (or appear
   * fewer times than expected) in production_orders.
   */
  missingTuples: BagDiff[];
  /**
   * Sample PO ids matching each surplus tuple (for forensic lookup).
   * Map key is JSON-stringified tuple.
   */
  surplusPoIds: Record<string, string[]>;
};

function normalizeTuple(
  src:
    | Pick<
        SoLineItem,
        | "productCode"
        | "sizeLabel"
        | "sizeCode"
        | "fabricCode"
        | "divanHeightInches"
        | "legHeightInches"
        | "gapInches"
      >
    | Pick<
        ProductionOrderRow,
        | "productCode"
        | "sizeLabel"
        | "sizeCode"
        | "fabricCode"
        | "divanHeightInches"
        | "legHeightInches"
        | "gapInches"
      >,
): AttributeTuple {
  // Treat null/undefined/"" as the same value so ACCESSORY rows (legitimately
  // empty sizeCode/fabricCode/etc.) compare cleanly.
  const norm = (v: unknown): string | null => {
    if (v === null || v === undefined || v === "") return null;
    return String(v);
  };
  const normNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    productCode: norm(src.productCode),
    sizeLabel: norm(src.sizeLabel),
    sizeCode: norm(src.sizeCode),
    fabricCode: norm(src.fabricCode),
    divanHeightInches: normNum(src.divanHeightInches),
    legHeightInches: normNum(src.legHeightInches),
    gapInches: normNum(src.gapInches),
  };
}

function tupleKey(t: AttributeTuple): string {
  // Stable JSON; field order in normalizeTuple is fixed.
  return JSON.stringify(t);
}

/**
 * Validate alignment via multiset comparison.
 *
 * Algorithm:
 *   1. Build expectedBag: from each SO line, push its tuple `quantity` times.
 *   2. Build actualBag: from each PO, push its tuple `quantity` times (POs
 *      are normally qty=1 each but historical data sometimes has rolled-up
 *      rows).
 *   3. For each tuple key, compare expected vs actual count. Diffs surface
 *      as surplusTuples / missingTuples.
 *   4. ok = same total count AND no diffs.
 */
export function validatePOAlignment(
  soLines: SoLineItem[],
  productionOrders: ProductionOrderRow[],
): ValidationResult {
  const expectedBag = new Map<string, { tuple: AttributeTuple; count: number }>();
  const actualBag = new Map<string, { tuple: AttributeTuple; count: number }>();
  const surplusPoIds: Record<string, string[]> = {};

  let expectedPoCount = 0;
  for (const line of soLines) {
    const tuple = normalizeTuple(line);
    const key = tupleKey(tuple);
    const qty = Number(line.quantity) || 1;
    expectedPoCount += qty;
    const entry = expectedBag.get(key);
    if (entry) entry.count += qty;
    else expectedBag.set(key, { tuple, count: qty });
  }

  let actualPoCount = 0;
  for (const po of productionOrders) {
    const tuple = normalizeTuple(po);
    const key = tupleKey(tuple);
    const qty = Number(po.quantity) || 1;
    actualPoCount += qty;
    const entry = actualBag.get(key);
    if (entry) entry.count += qty;
    else actualBag.set(key, { tuple, count: qty });
    // Track PO ids per tuple for forensic surplus lookup.
    if (!surplusPoIds[key]) surplusPoIds[key] = [];
    if (surplusPoIds[key].length < 5) surplusPoIds[key].push(po.id);
  }

  const allKeys = new Set<string>([...expectedBag.keys(), ...actualBag.keys()]);
  const surplusTuples: BagDiff[] = [];
  const missingTuples: BagDiff[] = [];

  for (const key of allKeys) {
    const exp = expectedBag.get(key);
    const act = actualBag.get(key);
    const expectedCount = exp?.count ?? 0;
    const actualCount = act?.count ?? 0;
    const tuple = (exp?.tuple ?? act?.tuple)!;
    const delta = actualCount - expectedCount;
    if (delta > 0) {
      surplusTuples.push({ tuple, expectedCount, actualCount, delta });
    } else if (delta < 0) {
      missingTuples.push({ tuple, expectedCount, actualCount, delta });
    }
  }

  // Trim surplusPoIds to only the tuples that actually have surplus.
  const surplusKeys = new Set(surplusTuples.map((s) => tupleKey(s.tuple)));
  for (const key of Object.keys(surplusPoIds)) {
    if (!surplusKeys.has(key)) delete surplusPoIds[key];
  }

  return {
    ok:
      expectedPoCount === actualPoCount &&
      surplusTuples.length === 0 &&
      missingTuples.length === 0,
    expectedPoCount,
    actualPoCount,
    surplusTuples,
    missingTuples,
    surplusPoIds,
  };
}

/**
 * D1 helper: load the SO lines + production orders for a given soId and
 * run the validator.
 */
export async function loadAndValidatePOAlignment(
  db: D1Database,
  soId: string,
): Promise<ValidationResult> {
  const linesRes = await db
    .prepare(
      `SELECT id, lineNo, lineSuffix, productCode, sizeLabel, sizeCode,
              fabricCode, divanHeightInches, legHeightInches, gapInches,
              quantity
         FROM sales_order_items WHERE salesOrderId = ?
         ORDER BY lineNo ASC`,
    )
    .bind(soId)
    .all<SoLineItem>();

  const posRes = await db
    .prepare(
      `SELECT id, poNo, productCode, sizeLabel, sizeCode, fabricCode,
              divanHeightInches, legHeightInches, gapInches, quantity
         FROM production_orders WHERE salesOrderId = ?
         ORDER BY id ASC`,
    )
    .bind(soId)
    .all<ProductionOrderRow>();

  return validatePOAlignment(linesRes.results ?? [], posRes.results ?? []);
}
