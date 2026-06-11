// ---------------------------------------------------------------------------
// Department-scan day splitting (owner 2026-06-11: workers scan a department
// QR when they START working there; punch-out ends the last stretch; the day's
// hours auto-fill into Working Hours split per department).
//
// Design rule: scans decide the SPLIT RATIO only — they never recompute pay.
// The day's paid hours come from the punch via the attendance rules engine
// exactly as before; these helpers carve that one total into department (and
// category) buckets that sum back to it TO THE CENT (largest-remainder).
//
// Pure functions — no DB, no Date.now — so the maths is unit-testable.
// ---------------------------------------------------------------------------

export type DeptScanEvent = {
  departmentCode: string;
  /** Minutes since midnight (Malaysia wall clock), like clockIn/clockOut. */
  atMin: number;
};

export type DeptBucket = { departmentCode: string; minutes: number };

/**
 * Carve the punch window into per-department minute buckets.
 * - No scans → the whole window belongs to the worker's HOME department.
 * - Time from clock-in to the FIRST scan belongs to the home department
 *   (the worker started at their own station, then walked over and scanned).
 * - Each scan starts its department until the next scan; the last runs to
 *   clock-out. Scans outside the punch window clamp to it.
 * - A worker can return to a department — minutes are SUMMED per department
 *   (Working Hours keeps one row per department × category).
 */
export function buildDeptBuckets(
  clockInMin: number,
  clockOutMin: number,
  homeDeptCode: string,
  events: DeptScanEvent[],
): DeptBucket[] {
  const out = Math.max(clockInMin, clockOutMin);
  if (out <= clockInMin) return [];
  const cleaned = (events ?? [])
    .filter((e) => e && typeof e.departmentCode === "string" && e.departmentCode.trim() !== "")
    .map((e) => ({
      departmentCode: e.departmentCode.trim().toUpperCase(),
      atMin: Math.min(Math.max(Math.round(e.atMin), clockInMin), out),
    }))
    .sort((a, b) => a.atMin - b.atMin);

  const perDept = new Map<string, number>();
  const add = (dept: string, minutes: number) => {
    if (minutes <= 0 || !dept) return;
    perDept.set(dept, (perDept.get(dept) ?? 0) + minutes);
  };

  let cursor = clockInMin;
  let currentDept = (homeDeptCode || "").trim().toUpperCase();
  for (const e of cleaned) {
    if (e.departmentCode === currentDept) continue; // re-scan of the same dept — no boundary
    add(currentDept, e.atMin - cursor);
    cursor = e.atMin;
    currentDept = e.departmentCode;
  }
  add(currentDept, out - cursor);

  // No home dept and no scans → nothing attributable (caller skips autofill).
  return [...perDept.entries()].map(([departmentCode, minutes]) => ({
    departmentCode,
    minutes,
  }));
}

/**
 * Pro-rata split of a decimal-hours total across weighted buckets, rounded to
 * 2 dp, with the rounding remainder assigned by largest fraction so the rows
 * ALWAYS sum back to the total exactly. Zero/negative weights are dropped;
 * an empty/zero weight set returns [].
 */
export function prorateHours<T extends { weight: number }>(
  totalHours: number,
  buckets: T[],
): Array<T & { hours: number }> {
  const safe = (buckets ?? []).filter((b) => b && b.weight > 0);
  const totalW = safe.reduce((s, b) => s + b.weight, 0);
  if (!(totalHours > 0) || totalW <= 0) return [];
  const totalCents = Math.round(totalHours * 100);
  const exact = safe.map((b) => (totalCents * b.weight) / totalW);
  const floors = exact.map((v) => Math.floor(v));
  let left = totalCents - floors.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const cents = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    cents[i] += 1;
    left -= 1;
  }
  return safe
    .map((b, i) => ({ ...b, hours: cents[i] / 100 }))
    .filter((b) => b.hours > 0);
}
