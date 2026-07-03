// ---------------------------------------------------------------------------
// Department-scan day splitting (owner 2026-06-11: workers scan a department
// QR when they START working there; punch-out ends the last stretch; the day's
// hours auto-fill into Working Hours split per department).
//
// 2026-06-11 v2 (owner: "需要清楚地分出来他们到底是在哪一个部门,是在 Sofa 还是
// Bedframe"): production-department QRs carry the CATEGORY too (Fab Sew·Sofa
// vs Fab Sew·Bedframe are separate codes on the wall). A scan boundary is any
// change of department OR category, so one worker's sofa-line hours and
// bedframe-line hours land in separate rows — per PERSON, not the department
// average.
//
// Design rule: scans decide the SPLIT RATIO only — they never recompute pay.
// The day's paid hours come from the punch via the attendance rules engine
// exactly as before; these helpers carve that one total into buckets that sum
// back to it TO THE CENT (largest-remainder).
//
// Pure functions — no DB, no Date.now — so the maths is unit-testable.
// ---------------------------------------------------------------------------

export type DeptScanEvent = {
  departmentCode: string;
  /** SOFA / BEDFRAME / ACCESSORY from a category QR; null = dept-only scan. */
  category?: string | null;
  /** Minutes since midnight (Malaysia wall clock), like clockIn/clockOut. */
  atMin: number;
};

export type DeptBucket = {
  departmentCode: string;
  /** Scanned category, or null when unknown (home-default / dept-only scan) —
   *  the caller falls back to the dept's job-card mix for null. */
  category: string | null;
  minutes: number;
};

/**
 * Carve the punch window into per-(department × category) minute buckets.
 * - No scans → the whole window belongs to the worker's HOME department
 *   (category null → caller derives it from the dept's job cards).
 * - Time from clock-in to the FIRST scan belongs to the home department.
 * - Each scan starts its (dept, category) until the next scan; the last runs
 *   to clock-out. Scans outside the punch window clamp to it.
 * - Re-scanning the SAME dept+category is not a boundary; switching category
 *   within one department IS (sofa line → bedframe line).
 * - Minutes are SUMMED per (dept, category) — one Working Hours row each.
 */
export function buildDeptBuckets(
  clockInMin: number,
  clockOutMin: number,
  homeDeptCode: string,
  events: DeptScanEvent[],
): DeptBucket[] {
  const out = Math.max(clockInMin, clockOutMin);
  if (out <= clockInMin) return [];
  const norm = (v: string | null | undefined) => {
    const s = (v ?? "").trim().toUpperCase();
    return s === "" ? null : s;
  };
  const cleaned = (events ?? [])
    .filter((e) => e && typeof e.departmentCode === "string" && e.departmentCode.trim() !== "")
    .map((e) => ({
      departmentCode: e.departmentCode.trim().toUpperCase(),
      category: norm(e.category),
      atMin: Math.min(Math.max(Math.round(e.atMin), clockInMin), out),
    }))
    .sort((a, b) => a.atMin - b.atMin);

  const perKey = new Map<string, DeptBucket>();
  const add = (dept: string, category: string | null, minutes: number) => {
    if (minutes <= 0 || !dept) return;
    const key = `${dept}|${category ?? ""}`;
    const cur = perKey.get(key);
    if (cur) cur.minutes += minutes;
    else perKey.set(key, { departmentCode: dept, category, minutes });
  };

  let cursor = clockInMin;
  let curDept = (homeDeptCode || "").trim().toUpperCase();
  let curCat: string | null = null;
  for (const e of cleaned) {
    if (e.departmentCode === curDept && e.category === curCat) continue; // same station re-scan
    add(curDept, curCat, e.atMin - cursor);
    cursor = e.atMin;
    curDept = e.departmentCode;
    curCat = e.category;
  }
  add(curDept, curCat, out - cursor);

  // No home dept and no scans → nothing attributable (caller skips autofill).
  return [...perKey.values()];
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
  // Fold sub-0.1h fragments into the largest bucket (owner 2026-07-04:
  // scan-boundary minutes were surfacing as confusing 0.01h/0.09h rows on
  // Working Hours). The fragment's cents MOVE — the rows still sum back to
  // the total exactly. If every bucket is tiny, they all collapse into the
  // single largest one rather than vanishing.
  const MIN_FRAGMENT_CENTS = 10;
  if (cents.length > 1) {
    let maxI = 0;
    for (let i = 1; i < cents.length; i++) if (cents[i] > cents[maxI]) maxI = i;
    for (let i = 0; i < cents.length; i++) {
      if (i !== maxI && cents[i] > 0 && cents[i] < MIN_FRAGMENT_CENTS) {
        cents[maxI] += cents[i];
        cents[i] = 0;
      }
    }
  }
  return safe
    .map((b, i) => ({ ...b, hours: cents[i] / 100 }))
    .filter((b) => b.hours > 0);
}
