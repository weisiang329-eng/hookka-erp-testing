// ---------------------------------------------------------------------------
// Fabric cascade helper.
//
// When a row in `raw_materials` with itemGroup in ('B.M-FABR','S.M-FABR',
// 'S-FABRIC') is INSERTED, UPDATED, or DELETED, we mirror the change into:
//   - fabrics            (master list; code keyed; category uses UNDERSCORE form)
//   - fabric_trackings   (analytics; fabricCode keyed; fabricCategory uses DOTTED form)
//
// Schema quirks worth remembering:
//   * `fabrics.category` is unconstrained TEXT but convention is the
//     UNDERSCORE form: BM_FABRIC / SM_FABRIC / S_FABRIC.
//   * `fabric_trackings.fabricCategory` has a CHECK constraint that accepts
//     ONLY `'B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING'` — note
//     `S-FABR` (no trailing `IC`) even though the raw_materials itemGroup is
//     `S-FABRIC`.
//   * Both sides use the raw_material `itemCode` as the key into fabrics.code
//     / fabric_trackings.fabricCode.
//
// All functions here return arrays of prepared D1 statements so the caller
// can fold them into a single `c.env.DB.batch([...])` for atomicity with the
// raw_materials write.
// ---------------------------------------------------------------------------

export const FABRIC_ITEM_GROUPS = new Set<string>([
  "B.M-FABR",
  "S.M-FABR",
  "S-FABRIC",
]);

/** Map raw_materials.itemGroup → fabrics.category (underscore form). */
export function itemGroupToFabricCategory(itemGroup: string): string | null {
  switch (itemGroup) {
    case "B.M-FABR":
      return "BM_FABRIC";
    case "S.M-FABR":
      return "SM_FABRIC";
    case "S-FABRIC":
      return "S_FABRIC";
    default:
      return null;
  }
}

/**
 * Map raw_materials.itemGroup → fabric_trackings.fabricCategory (dotted form
 * as enforced by the CHECK constraint).
 *
 * IMPORTANT: `S-FABRIC` -> `S-FABR` (the CHECK does NOT accept `S-FABRIC`).
 */
export function itemGroupToTrackingCategory(itemGroup: string): string | null {
  switch (itemGroup) {
    case "B.M-FABR":
      return "B.M-FABR";
    case "S.M-FABR":
      return "S.M-FABR";
    case "S-FABRIC":
      return "S-FABR";
    default:
      return null;
  }
}

export function isFabricGroup(itemGroup: string | null | undefined): boolean {
  return !!itemGroup && FABRIC_ITEM_GROUPS.has(itemGroup);
}

function genFabricId(): string {
  return `fab-${crypto.randomUUID().slice(0, 8)}`;
}

function genTrackingId(): string {
  return `ft-${crypto.randomUUID().slice(0, 8)}`;
}

export type CascadeInput = {
  itemCode: string;
  description: string;
  itemGroup: string;
  balanceQty: number;
  /** If omitted uses defaults (priceSen=0 / price=0). Never overwrites on update. */
  priceSen?: number;
};

/**
 * Build statements to UPSERT fabric + fabric_tracking rows mirroring a
 * raw_material. Preserves existing priceSen / priceTier / price on update —
 * we ONLY overwrite identity columns (name, category, soh, description).
 */
export async function buildFabricUpsertStatements(
  db: D1Database,
  input: CascadeInput,
): Promise<D1PreparedStatement[]> {
  if (!isFabricGroup(input.itemGroup)) return [];
  const fabCategory = itemGroupToFabricCategory(input.itemGroup);
  const trackCategory = itemGroupToTrackingCategory(input.itemGroup);
  if (!fabCategory || !trackCategory) return [];

  const stmts: D1PreparedStatement[] = [];

  // --- fabrics upsert (keyed on code) ---
  const existingFab = await db
    .prepare("SELECT id FROM fabrics WHERE code = ? LIMIT 1")
    .bind(input.itemCode)
    .first<{ id: string }>();
  if (existingFab) {
    // Update identity columns + soh, PRESERVE priceSen.
    stmts.push(
      db
        .prepare(
          `UPDATE fabrics SET name = ?, category = ?, sohMeters = ? WHERE id = ?`,
        )
        .bind(input.description, fabCategory, input.balanceQty, existingFab.id),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO fabrics (id, code, name, category, priceSen, sohMeters, reorderLevel)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genFabricId(),
          input.itemCode,
          input.description,
          fabCategory,
          Number.isFinite(input.priceSen) ? Number(input.priceSen) : 0,
          input.balanceQty,
          0,
        ),
    );
  }

  // --- fabric_trackings upsert (keyed on fabricCode) ---
  const existingTrack = await db
    .prepare("SELECT id FROM fabric_trackings WHERE fabricCode = ? LIMIT 1")
    .bind(input.itemCode)
    .first<{ id: string }>();
  if (existingTrack) {
    // Preserve priceTier / price / usage / shortage / reorderPoint.
    stmts.push(
      db
        .prepare(
          `UPDATE fabric_trackings SET fabricDescription = ?, fabricCategory = ?, soh = ? WHERE id = ?`,
        )
        .bind(
          input.description,
          trackCategory,
          input.balanceQty,
          existingTrack.id,
        ),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO fabric_trackings
             (id, fabricCode, fabricDescription, fabricCategory, priceTier,
              price, soh, poOutstanding, lastMonthUsage, oneWeekUsage,
              twoWeeksUsage, oneMonthUsage, shortage, reorderPoint, supplier, leadTimeDays)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genTrackingId(),
          input.itemCode,
          input.description,
          trackCategory,
          "PRICE_2", // default tier (seed data uses PRICE_2)
          0, // price
          input.balanceQty, // soh
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          null,
          0,
        ),
    );
  }

  return stmts;
}

/** Build statements to delete the mirror fabric + fabric_tracking rows by code. */
export function buildFabricDeleteStatements(
  db: D1Database,
  itemCode: string,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM fabrics WHERE code = ?").bind(itemCode),
    db.prepare("DELETE FROM fabric_trackings WHERE fabricCode = ?").bind(itemCode),
  ];
}

/**
 * Soft guard: check whether a fabricCode is still referenced by
 * sales_order_items (sales_orders that are not cancelled). Returns the count.
 */
export async function countActiveSalesOrderRefs(
  db: D1Database,
  fabricCode: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE soi.fabricCode = ?
          AND COALESCE(so.status, '') != 'CANCELLED'`,
    )
    .bind(fabricCode)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
