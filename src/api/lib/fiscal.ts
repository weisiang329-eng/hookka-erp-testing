// ---------------------------------------------------------------------------
// fiscal.ts — financial-year helpers (Phase 1, owner-maintainable FYE).
//
// The FYE (financial year end) month lives in kv_config under `fye_month`
// as { month: 1..12 } — e.g. 3 = year ends 31 Mar, 8 = 31 Aug. Everything
// fiscal-year-aware (P&L YTD window, quarter/half buckets, year-end profit
// close, cost-structure pages) reads it through getFyeMonth so changing
// the setting in the Accounting UI re-bases every report consistently.
//
// Default: 12 (calendar year) until the owner sets it. Changing FYE after
// data exists re-bases historical YTD/quarter groupings — the settings UI
// warns about this.
// ---------------------------------------------------------------------------
import type { Env } from "../worker";

type Db = Env["Variables"]["DB"];

export const FYE_KV_KEY = "fye_month";

export async function getFyeMonth(db: Db): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind(FYE_KV_KEY)
    .first<{ value: string }>();
  try {
    const v = JSON.parse(row?.value ?? "null") as { month?: number } | null;
    if (
      v &&
      typeof v.month === "number" &&
      Number.isInteger(v.month) &&
      v.month >= 1 &&
      v.month <= 12
    )
      return v.month;
  } catch {
    /* fall through to default */
  }
  return 12;
}

/**
 * Financial-year window containing `date` for the given FYE month.
 * FYE 3 (31 Mar) and date 2026-06-10 → start 2026-04-01, end 2027-03-31.
 * Returned as ISO date strings (inclusive start, inclusive end).
 */
export function fyWindowFor(
  date: Date,
  fyeMonth: number,
): { startIso: string; endIso: string; label: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1..12
  // FY starts the month AFTER the FYE month.
  const startMonth = (fyeMonth % 12) + 1;
  // If we're past the FY start month this calendar year, the FY started
  // this year; otherwise it started last year. Calendar-year FYE (12)
  // degenerates to start Jan of the current year.
  const startYear = m >= startMonth ? y : y - 1;
  const endYear = fyeMonth === 12 ? startYear : startYear + 1;
  const startIso = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const endDay = new Date(Date.UTC(endYear, fyeMonth, 0)).getUTCDate();
  const endIso = `${endYear}-${String(fyeMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
  const label =
    fyeMonth === 12 ? `FY ${startYear}` : `FY ${startYear}/${String(endYear).slice(2)}`;
  return { startIso, endIso, label };
}
