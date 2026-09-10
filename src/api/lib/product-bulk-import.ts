// Fields absent from `row` stay absent from the returned shape (never
// defaulted) so callers can do `shaped.field !== undefined ? ... : existing`
// and a blank sheet cell never overwrites a saved value.
export const PRODUCT_BULK_CATEGORIES = ["BEDFRAME", "SOFA", "ACCESSORY"] as const;
export const PRODUCT_BULK_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export type ProductBulkImportInput = {
  id?: unknown; // if present and matches an existing row, code changes are a rename not a new row
  code?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  baseModel?: unknown;
  sizeCode?: unknown;
  sizeLabel?: unknown;
  basePriceSen?: unknown; // RM, not sen — matches sheet column, converted below
  costPriceSen?: unknown; // RM, not sen
  fabricUsage?: unknown;
  unitM3?: unknown;
  status?: unknown;
};

export type ShapedProductBulkRow = {
  id?: string;
  code: string;
  name?: string;
  category?: string;
  description?: string;
  baseModel?: string;
  sizeCode?: string;
  sizeLabel?: string;
  basePriceSen?: number;
  costPriceSen?: number;
  fabricUsage?: number;
  unitM3?: number;
  status?: string;
};

function bulkStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function bulkNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function shapeProductBulkRow(
  row: ProductBulkImportInput,
): { ok: true; row: ShapedProductBulkRow } | { ok: false; reason: string } {
  const code = bulkStr(row.code);
  if (!code) return { ok: false, reason: "code is required" };

  const name = bulkStr(row.name);
  if (row.name !== undefined && !name) {
    return { ok: false, reason: "name is required" };
  }
  const category = bulkStr(row.category);
  let categoryUpper: string | undefined;
  if (category !== undefined) {
    categoryUpper = category.toUpperCase();
    if (!(PRODUCT_BULK_CATEGORIES as readonly string[]).includes(categoryUpper)) {
      return {
        ok: false,
        reason: `category must be one of ${PRODUCT_BULK_CATEGORIES.join(", ")} (got "${category}")`,
      };
    }
  }
  const status = bulkStr(row.status);
  let statusUpper: string | undefined;
  if (status !== undefined) {
    statusUpper = status.toUpperCase();
    if (!(PRODUCT_BULK_STATUSES as readonly string[]).includes(statusUpper)) {
      return {
        ok: false,
        reason: `status must be one of ${PRODUCT_BULK_STATUSES.join(", ")} (got "${status}")`,
      };
    }
  }

  const out: ShapedProductBulkRow = { code };
  const id = bulkStr(row.id);
  if (id !== undefined) out.id = id;
  if (name !== undefined) out.name = name;
  if (categoryUpper !== undefined) out.category = categoryUpper;
  if (statusUpper !== undefined) out.status = statusUpper;
  const description = bulkStr(row.description);
  if (description !== undefined) out.description = description;
  const baseModel = bulkStr(row.baseModel);
  if (baseModel !== undefined) out.baseModel = baseModel;
  const sizeCode = bulkStr(row.sizeCode);
  if (sizeCode !== undefined) out.sizeCode = sizeCode;
  const sizeLabel = bulkStr(row.sizeLabel);
  if (sizeLabel !== undefined) out.sizeLabel = sizeLabel;
  const basePriceRm = bulkNum(row.basePriceSen);
  if (basePriceRm !== undefined) out.basePriceSen = Math.round(basePriceRm * 100);
  const costPriceRm = bulkNum(row.costPriceSen);
  if (costPriceRm !== undefined) out.costPriceSen = Math.round(costPriceRm * 100);
  const fabricUsage = bulkNum(row.fabricUsage);
  if (fabricUsage !== undefined) out.fabricUsage = fabricUsage;
  const unitM3 = bulkNum(row.unitM3);
  if (unitM3 !== undefined) out.unitM3 = unitM3;

  // Mirrors POST / and PUT /:id (BUG-2026-06-22-008).
  if (categoryUpper === "BEDFRAME" && !sizeCode) {
    return {
      ok: false,
      reason: "sizeCode is required for BEDFRAME products",
    };
  }

  return { ok: true, row: out };
}
