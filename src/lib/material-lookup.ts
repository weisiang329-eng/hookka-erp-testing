// ---------------------------------------------------------------------------
// Unified material / fabric stock lookup — single entry point for querying
// stock-on-hand across the three overlapping data sources in mock-data.ts:
//
//   1. fabricTrackings[] — operational tracking (most detailed, has soh field)
//   2. fabrics[]         — simplified catalog (sohMeters field)
//   3. rawMaterials[]    — AutoCount import (balanceQty field)
//
// Consumers (e.g. MRP route) call these helpers instead of maintaining their
// own hardcoded stock constants.
// ---------------------------------------------------------------------------

import {
  fabricTrackings,
  fabrics,
  rawMaterials,
} from "@/lib/mock-data";
import type { RawMaterial } from "@/lib/mock-data";

/**
 * Look up fabric stock on hand by fabric code.
 *
 * Priority:
 *   1. fabricTrackings (operational, has per-code soh)
 *   2. fabrics (catalog, sohMeters)
 *   3. rawMaterials (AutoCount import, balanceQty — matched by itemCode)
 *
 * Returns { soh, unit, source } so callers know where the number came from.
 */
export function getFabricStock(
  fabricCode: string,
): { soh: number; unit: string; source: string } {
  // 1. Try fabricTrackings first (most detailed)
  const ft = fabricTrackings.find((t) => t.fabricCode === fabricCode);
  if (ft && ft.soh > 0) {
    return { soh: ft.soh, unit: "MTR", source: "fabricTracking" };
  }

  // 2. Fall back to fabrics[] sohMeters
  const fab = fabrics.find((f) => f.code === fabricCode);
  if (fab && fab.sohMeters > 0) {
    return { soh: fab.sohMeters, unit: "MTR", source: "fabrics" };
  }

  // 3. Fall back to rawMaterials[] balanceQty
  const rm = rawMaterials.find((r) => r.itemCode === fabricCode);
  if (rm && rm.balanceQty > 0) {
    return { soh: rm.balanceQty, unit: rm.baseUOM, source: "rawMaterials" };
  }

  // If fabricTracking exists but soh is 0, still return it (real zero)
  if (ft) {
    return { soh: ft.soh, unit: "MTR", source: "fabricTracking" };
  }
  if (fab) {
    return { soh: fab.sohMeters, unit: "MTR", source: "fabrics" };
  }
  if (rm) {
    return { soh: rm.balanceQty, unit: rm.baseUOM, source: "rawMaterials" };
  }

  return { soh: 0, unit: "MTR", source: "none" };
}

/**
 * Look up raw material stock by material category (e.g. "PLYWOOD", "BM_FABRIC").
 *
 * Aggregates balanceQty from all rawMaterials in the matching itemGroup.
 * The category-to-itemGroup mapping handles the naming differences between
 * BOM categories and AutoCount item groups.
 */
const CATEGORY_TO_ITEM_GROUPS: Record<string, string[]> = {
  BM_FABRIC: ["B.M-FABR"],
  SM_FABRIC: ["S.M-FABR", "S-FABR"],
  PLYWOOD: ["PLYWOOD"],
  WD_STRIP: ["B.OTHERS"], // wood strips are in B.OTHERS
  B_FILLER: ["BED-FILL"],
  S_FILLER: ["SOFA-FIL"],
  WEBBING: ["WEBBING"],
  S_WEBBING: ["WEBBING"],
  MECHANISM: ["EQUIPMEN"],
  S_MECHANISM: ["EQUIPMEN"],
  ACCESSORIES: ["B.OTHERS"],
  PACKING: ["PACKING"],
};

export function getRawMaterialStock(
  materialCategory: string,
): { onHand: number; unit: string; source: string; items: RawMaterial[] } {
  const groups = CATEGORY_TO_ITEM_GROUPS[materialCategory];

  if (groups) {
    const items = rawMaterials.filter(
      (rm) => rm.isActive && groups.includes(rm.itemGroup),
    );
    const onHand = items.reduce((sum, rm) => sum + rm.balanceQty, 0);
    const unit = items[0]?.baseUOM || "PCS";
    return { onHand, unit, source: "rawMaterials", items };
  }

  // Direct category match attempt
  const items = rawMaterials.filter(
    (rm) => rm.isActive && rm.itemGroup === materialCategory,
  );
  if (items.length > 0) {
    const onHand = items.reduce((sum, rm) => sum + rm.balanceQty, 0);
    return { onHand, unit: items[0].baseUOM, source: "rawMaterials", items };
  }

  return { onHand: 0, unit: "PCS", source: "none", items: [] };
}
