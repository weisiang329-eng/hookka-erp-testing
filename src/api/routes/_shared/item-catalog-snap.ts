// ---------------------------------------------------------------------------
// item-catalog-snap.ts — shared helper that enforces "catalog wins" on every
// SO/CO line item write. Closes the OCR back-door BUG-001 + BUG-002 documented
// in `arch_ocr_backdoors.md` (memory).
//
// Intent: when a request body line has a `productCode` that resolves to a
// catalog product, that product is the source of truth for productName,
// itemCategory, productId, and (for non-SOFA) sizeLabel/sizeCode. Whatever
// the client sent for those fields is OVERWRITTEN with the catalog value.
// Prevents PDF text or hand-typed strings from polluting category-A fields
// regardless of which write path the client used (POST, PUT, OCR import).
//
// Pure function — no IO. Caller pre-loads the catalog ONCE per request and
// passes a productByCode Map. Reusable across sales-orders.ts POST/PUT and
// consignment-orders.ts POST/PUT.
//
// Behavior matrix:
//   productCode resolves to catalog → canonical-cased + catalog wins for:
//                                       productId, productName, itemCategory,
//                                       sizeLabel (BF/ACC), sizeCode (BF/ACC)
//   productCode does NOT resolve     → input pass-through unchanged
//                                       (caller's existing validation gates —
//                                       e.g. unknown-product-code rejection
//                                       — handle the unmatched case)
//
// SOFA exception: sizeLabel here is the seat-height number ("28") not the
// catalog variant tag ("1A(LHF)"), so client wins. The caller is responsible
// for normalizing the SOFA seat to '28"' (sales-orders.ts already does this).
// ---------------------------------------------------------------------------

export type CatalogSnapProduct = {
  id: string;
  code: string;
  name: string;
  category: string;
  sizeCode: string | null;
  sizeLabel: string | null;
};

export type CatalogSnapInput = {
  productCode?: unknown;
  productId?: unknown;
  productName?: unknown;
  itemCategory?: unknown;
  sizeCode?: unknown;
  sizeLabel?: unknown;
};

export type CatalogSnapResult = {
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  /** True when productCode resolved to a catalog product; false when the input
   * passed through unchanged (caller's other validation gates take over). */
  matched: boolean;
};

export function snapItemToCatalog(
  input: CatalogSnapInput,
  productByCode: Map<string, CatalogSnapProduct>,
): CatalogSnapResult {
  const rawCode = String(input.productCode ?? "").trim();
  const product = rawCode ? productByCode.get(rawCode) : undefined;
  const incomingCategory = String(input.itemCategory ?? "") || "BEDFRAME";
  const incomingSizeLabel = String(input.sizeLabel ?? "");
  const incomingSizeCode = String(input.sizeCode ?? "");

  if (!product) {
    return {
      productId: String(input.productId ?? ""),
      productCode: rawCode,
      productName: String(input.productName ?? "") || rawCode,
      itemCategory: incomingCategory,
      sizeCode: incomingSizeCode,
      sizeLabel: incomingSizeLabel,
      matched: false,
    };
  }

  const isSofa = product.category === "SOFA";
  return {
    productId: product.id,
    productCode: product.code,
    productName: product.name,
    itemCategory: product.category,
    // SOFA: sizeLabel is the seat height (e.g. "28""), client-supplied. The
    // catalog product.sizeLabel for SOFA is the variant tag ("1A(LHF)") which
    // is encoded in productCode already — don't overwrite seat height with it.
    sizeLabel: isSofa
      ? incomingSizeLabel
      : (product.sizeLabel ?? incomingSizeLabel),
    sizeCode: isSofa
      ? incomingSizeCode
      : (product.sizeCode ?? incomingSizeCode),
    matched: true,
  };
}

// ---------------------------------------------------------------------------
// Bulk loader — single round-trip across all categories. Caller passes the
// Hyperdrive-bound DB; result is the productByCode Map suitable for repeated
// snapItemToCatalog calls within the same request.
// ---------------------------------------------------------------------------
export async function loadProductCatalog(
  db: D1Database,
): Promise<Map<string, CatalogSnapProduct>> {
  const res = await db
    .prepare(
      `SELECT id, code, name, category, sizeCode, sizeLabel
         FROM products
        WHERE status = 'ACTIVE'`,
    )
    .all<CatalogSnapProduct>();
  const out = new Map<string, CatalogSnapProduct>();
  for (const p of res.results ?? []) {
    if (p.code) out.set(p.code, p);
  }
  return out;
}
