// ---------------------------------------------------------------------------
// The fixed choices on an employee record.
//
// Position and Category are dropdowns on the Employee Master inline-edit row
// and on the Add Employee form, but the drawer shipped Position as a free-text
// box and Category as a checkbox wall — three doors to one record, two of them
// with different rules (owner 2026-08-02: 「为什么不是dropdown」「规格全部一样？」).
// The lists live here so there is one answer.
// ---------------------------------------------------------------------------

/** Every position a factory employee can hold. */
export const POSITIONS = ["Operator", "Operator Leader"] as const;
export type Position = (typeof POSITIONS)[number];

/**
 * Production lines an Operator Leader can be scoped to. "" (All) means no
 * filter — stored as an empty array, which is also what a leader who covers
 * every line gets.
 *
 * Categories apply to Operator Leaders ONLY: they gate which (dept × category)
 * cells the Team dashboard surfaces, and a plain Operator has no such scope.
 */
export const LEADER_CATEGORIES = ["SOFA", "BEDFRAME"] as const;

/** Does this position own a category scope at all? */
export function positionHasCategory(position: string): boolean {
  return position === "Operator Leader";
}

/**
 * Options for the Category dropdown, given what is already stored.
 *
 * A worker whose record predates this list (ACCESSORY, say, or anything a
 * future migration adds) keeps their value as a choice instead of having the
 * select silently coerce it to "All" on the next save.
 */
export function categoryOptions(current: string | undefined | null): string[] {
  const cur = String(current ?? "").trim();
  const base: string[] = [...LEADER_CATEGORIES];
  if (cur && !base.includes(cur)) base.push(cur);
  return base;
}
