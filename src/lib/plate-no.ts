// ---------------------------------------------------------------------------
// plate-no.ts — one truck is one truck, however the operator typed its plate.
//
// `three_pl_vehicles.plate_no` is stored exactly as typed and carries no unique
// index (migration 0063 only indexes provider_id). So "AKF 8100", "AKF8100" and
// "akf-8100" are three vehicles, and because `delivery_orders` denormalizes
// `vehicleId` / `vehicleType`, one truck's delivery history splits three ways —
// utilisation, 3PL rates and cost-per-trip are all computed off whichever row
// happened to be picked that day.
//
// Ported from Houzs-ERP #1492 ("lorry plates are stored canonical, and the
// duplicates get a gated repair"). One deliberate difference: they canonicalise
// the STORED value; we keep what the operator typed for display — a DO that
// prints "AKF8100" when the lorry says "AKF 8100" is a regression on paperwork
// a driver actually reads — and match on a separate normalized column.
// ---------------------------------------------------------------------------

/**
 * The comparison form of a plate: letters and digits only, upper-cased.
 * Malaysian plates carry no meaningful punctuation, so spaces, hyphens and dots
 * are formatting rather than identity.
 *
 *   "AKF 8100" → "AKF8100"
 *   "akf-8100" → "AKF8100"
 *   " W 1234 A " → "W1234A"
 */
export function normalizePlate(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Group any plate-bearing rows by their normalized form and return only the
 * groups with more than one member — i.e. the same truck entered twice.
 *
 * Used by the read-only collision report. Kept pure so it can be tested without
 * a database, and reused if a gated repair is written later.
 */
export function findPlateCollisions<T extends { id: string; plateNo?: string | null }>(
  rows: T[],
): { normalized: string; rows: T[] }[] {
  const byNorm = new Map<string, T[]>();
  for (const r of rows) {
    const n = normalizePlate(r.plateNo);
    if (!n) continue; // a blank plate is a different problem
    const arr = byNorm.get(n);
    if (arr) arr.push(r);
    else byNorm.set(n, [r]);
  }
  return [...byNorm.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([normalized, rs]) => ({ normalized, rows: rs }))
    .sort((a, b) => a.normalized.localeCompare(b.normalized));
}
