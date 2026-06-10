/**
 * Total production minutes for a job card. Merged FABRIC CUTTING (FAB_CUT) cards
 * store estMinutes/productionTimeMinutes as the per-SET TOTAL (sum of all
 * pieces), with wipQty = piece count — so that total must NOT be multiplied by
 * wipQty. Every other dept stores PER-PIECE minutes, so total = per-piece ×
 * wipQty. Mirrors the cost cascade, which already costs the un-multiplied total.
 */
export function jcMinutesTotal(
  perUnitMinutes: number,
  jc: { departmentCode?: string | null; wipQty?: number | null },
): number {
  if ((jc.departmentCode ?? "") === "FAB_CUT") return perUnitMinutes || 0;
  return (perUnitMinutes || 0) * Math.max(1, jc.wipQty ?? 1);
}
