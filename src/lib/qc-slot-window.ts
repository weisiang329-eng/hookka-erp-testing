// ---------------------------------------------------------------------------
// qc-slot-window — which QC slots the Pending tab shows by default.
//
// The 12:00/16:00 cron generates one inspection per active template, twice a
// day, and nothing clears them. On 2026-08-01 that had accumulated to 2,839
// PENDING inspections across 96 days (2026-04-28 → 2026-08-01, ~34/day) — not
// one had ever been completed. Opening the page therefore meant reading a
// four-month backlog to find today's checklist.
//
// Showing a recent window by default is a display choice, NOT a data change:
// nothing is deleted, hidden slots are one dropdown away, and the "N open"
// badge keeps counting every open inspection so the backlog stays visible.
//
// Pure + dependency-free so the boundary arithmetic is unit-testable — an
// off-by-one here hides the slot someone is meant to be filling in right now.
// ---------------------------------------------------------------------------

/** Window choices offered in the UI. 0 means "no window — show everything". */
export const QC_WINDOW_DAYS = [7, 30, 0] as const;
export type QcWindowDays = (typeof QC_WINDOW_DAYS)[number];

export const QC_DEFAULT_WINDOW_DAYS: QcWindowDays = 7;

export function qcWindowLabel(days: number): string {
  return days === 0 ? "All slots" : `Last ${days} days`;
}

/**
 * The earliest slot day still inside the window, as `YYYY-MM-DD`.
 *
 * Inclusive of both ends: a 7-day window on 2026-08-01 keeps 2026-07-26
 * through 2026-08-01, which is seven calendar days, not eight.
 */
export function windowStartDay(todayIso: string, days: number): string {
  const base = String(todayIso).slice(0, 10);
  if (days <= 0) return "";
  const ms = Date.parse(`${base}T00:00:00Z`);
  if (Number.isNaN(ms)) return "";
  return new Date(ms - (days - 1) * 86400000).toISOString().slice(0, 10);
}

export type SlotGroup<T> = readonly [string, T[]];

export type SlotWindowResult<T> = {
  /** Groups inside the window, in the order they came in. */
  shown: SlotGroup<T>[];
  /** How many groups the window left out. */
  hiddenGroups: number;
  /** How many individual inspections the window left out. */
  hiddenRows: number;
};

/**
 * Keep the slot groups whose scheduled day is inside the window.
 *
 * A group whose key is not a parseable date (the "no-slot" bucket) is ALWAYS
 * kept — an inspection with no schedule is the last thing that should be
 * silently hidden.
 */
export function sliceSlotGroups<T>(
  groups: readonly SlotGroup<T>[],
  days: number,
  todayIso: string,
): SlotWindowResult<T> {
  if (days <= 0) {
    return { shown: groups.slice(), hiddenGroups: 0, hiddenRows: 0 };
  }
  const from = windowStartDay(todayIso, days);
  if (!from) {
    return { shown: groups.slice(), hiddenGroups: 0, hiddenRows: 0 };
  }
  const shown: SlotGroup<T>[] = [];
  let hiddenGroups = 0;
  let hiddenRows = 0;
  for (const g of groups) {
    const day = String(g[0]).slice(0, 10);
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(day);
    if (!dated || day >= from) {
      shown.push(g);
    } else {
      hiddenGroups += 1;
      hiddenRows += g[1].length;
    }
  }
  return { shown, hiddenGroups, hiddenRows };
}
