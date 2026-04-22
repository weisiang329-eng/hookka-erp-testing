// ---------------------------------------------------------------------------
// production_lead_times seed + lookup helpers.
//
// `production_lead_times` is a (category, deptCode) → days map used by the
// BOM → job_cards reverse-schedule in sales-orders.ts (Track H). If the table
// is empty we seed safe defaults so new SO confirmations don't produce
// jobCards with stacked-on-single-day due dates.
//
// The `category` column is CHECK-constrained to ('BEDFRAME','SOFA'), so we
// only seed those two. ACCESSORY POs fall back to BEDFRAME values.
//
// NOTE: the defaults chosen below mirror the spec's Track-H example:
//   BEDFRAME total = 11 days end-to-end (FAB_CUT 1 + FAB_SEW 1 + WOOD_CUT 2 +
//   FOAM 1 + FRAMING 2 + WEBBING 1 + UPHOLSTERY 2 + PACKING 1).
//   SOFA uses the same per-dept numbers — the extra WIPs (cushion, armrest,
//   etc.) run in parallel so the calendar footprint is comparable.
// ---------------------------------------------------------------------------

export type LeadTimeMap = Record<string, Record<string, number>>;

export const DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
] as const;

const DEFAULT_LEAD_DAYS: LeadTimeMap = {
  BEDFRAME: {
    FAB_CUT: 1,
    FAB_SEW: 1,
    WOOD_CUT: 2,
    FOAM: 1,
    FRAMING: 2,
    WEBBING: 1,
    UPHOLSTERY: 2,
    PACKING: 1,
  },
  SOFA: {
    FAB_CUT: 1,
    FAB_SEW: 1,
    WOOD_CUT: 2,
    FOAM: 1,
    FRAMING: 2,
    WEBBING: 1,
    UPHOLSTERY: 2,
    PACKING: 1,
  },
};

// Insert default rows IFF the table is empty. Safe to call on every cascade —
// the COUNT(*) short-circuits after the first successful seed.
export async function ensureLeadTimesSeeded(db: D1Database): Promise<void> {
  const res = await db
    .prepare("SELECT COUNT(*) as n FROM production_lead_times")
    .first<{ n: number }>();
  if (res && res.n > 0) return;

  const statements: D1PreparedStatement[] = [];
  for (const category of Object.keys(DEFAULT_LEAD_DAYS)) {
    const depts = DEFAULT_LEAD_DAYS[category];
    for (const deptCode of Object.keys(depts)) {
      statements.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO production_lead_times (category, deptCode, days) VALUES (?, ?, ?)",
          )
          .bind(category, deptCode, depts[deptCode]),
      );
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

// Load the full (category, deptCode) → days map. Falls back to the in-file
// DEFAULT_LEAD_DAYS for any missing (category, deptCode) pair so callers
// never hit undefined. BEDFRAME values are used as the fallback category
// (ACCESSORY, etc.).
export async function loadLeadTimes(db: D1Database): Promise<LeadTimeMap> {
  const res = await db
    .prepare("SELECT category, deptCode, days FROM production_lead_times")
    .all<{ category: string; deptCode: string; days: number }>();
  const map: LeadTimeMap = { BEDFRAME: {}, SOFA: {} };
  for (const row of res.results ?? []) {
    if (!map[row.category]) map[row.category] = {};
    map[row.category][row.deptCode] = row.days;
  }
  // Merge defaults for any missing entries.
  for (const cat of Object.keys(DEFAULT_LEAD_DAYS)) {
    if (!map[cat]) map[cat] = {};
    for (const dept of Object.keys(DEFAULT_LEAD_DAYS[cat])) {
      if (map[cat][dept] == null) {
        map[cat][dept] = DEFAULT_LEAD_DAYS[cat][dept];
      }
    }
  }
  return map;
}

// Look up days for (category, deptCode) with a 1-day safe fallback.
export function leadDaysFor(
  map: LeadTimeMap,
  category: string,
  deptCode: string,
): number {
  const normalized = category === "SOFA" ? "SOFA" : "BEDFRAME";
  const v = map[normalized]?.[deptCode];
  if (typeof v === "number" && v >= 0) return v;
  return 1;
}

// Add N days to an ISO-date string (YYYY-MM-DD), returning YYYY-MM-DD.
// Subtract by passing a negative N.
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
