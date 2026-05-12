/**
 * Returns true if `w` is assignable to a job card in production department
 * `dept`. The worker covers a dept when either
 *   - `dept` is listed in their multi-dept array (`departmentCodes`), or
 *   - `dept` equals the legacy single `departmentCode` field (for workers
 *     who haven't been migrated to the array model yet).
 *
 * Strict mode (option 🅐.1 from the 2026-05-12 PIC dropdown filter
 * discussion): returns FALSE when a worker has neither field populated.
 * Operators using PIC dropdowns shouldn't see non-production staff or
 * brand-new hires with no dept yet — if they need to appear, the fix is
 * to assign a dept in Employee Master, not to relax this filter.
 *
 * `dept` empty / falsy means "no dept context yet" (e.g. the QR scan flow
 * before a job card is looked up) — the helper short-circuits to TRUE so
 * the caller can render the dropdown without a filter while the dept is
 * being resolved.
 *
 * Structural-typed on purpose: production/types.ts ships a slimmed-down
 * Worker (id + name + departmentCode + empNo) while @/types ships the
 * full record. Both satisfy the shape below, so callers from either side
 * compile without juggling types.
 */
export function workerCoversDept(
  w: { departmentCode?: string | null; departmentCodes?: string[] | null },
  dept: string,
): boolean {
  if (!dept) return true;
  const codes =
    Array.isArray(w.departmentCodes) && w.departmentCodes.length > 0
      ? w.departmentCodes
      : w.departmentCode
        ? [w.departmentCode]
        : [];
  return codes.includes(dept);
}
