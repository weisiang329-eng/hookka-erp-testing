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
  "FOAM_CUTTING",
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
    FOAM_CUTTING: 1,
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
    FOAM_CUTTING: 1,
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

// Load the (category, deptCode) → days map effective ON or BEFORE `asOfDate`
// (default: today, ISO YYYY-MM-DD). Single source of truth: the *_history
// tables. Both inline /planning Save and the dialog Schedule flow write
// here; this resolver picks the latest effective_from <= asOf per (cat,
// dept), tiebreaking on created_at.
//
// Migration 0105 created the table; 0106 backfilled the legacy
// production_lead_times baseline rows in with effective_from='2020-01-01'
// so any historical SO confirm finds a value. Falls back to the in-file
// DEFAULT_LEAD_DAYS only when neither history nor backfill has a row for
// that (cat, dept) — which in practice only happens on a fresh install
// where 0106 hasn't run yet, or for new categories added to the constant.
//
// Postgres column is `dept_code` (snake_case). The D1Compat adapter
// translates camelCase identifiers in the SQL string to snake_case for
// the underlying query, but does NOT camelCase the result rows. SELECT
// `dept_code AS "deptCode"` covers both runtime modes (raw Postgres in
// tests, D1 + adapter in workers).
export async function loadLeadTimes(
  db: D1Database,
  asOfDate?: string,
): Promise<LeadTimeMap> {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const map: LeadTimeMap = { BEDFRAME: {}, SOFA: {} };

  // History → latest effective_from <= asOf wins per (cat, dept).
  // DISTINCT ON keeps the first row in each (category, dept_code) group;
  // ORDER BY pins the newest effective_from + tiebreaks on created_at.
  const histRes = await db
    .prepare(
      `SELECT DISTINCT ON (category, dept_code)
              category, dept_code AS "deptCode", days
         FROM production_lead_times_history
        WHERE effective_from <= ?
        ORDER BY category, dept_code, effective_from DESC, created_at DESC`,
    )
    .bind(asOf)
    .all<{ category: string; deptCode?: string; dept_code?: string; days: number }>();
  for (const row of histRes.results ?? []) {
    if (!map[row.category]) map[row.category] = {};
    const dept = row.deptCode ?? row.dept_code;
    if (typeof dept !== "string" || !dept) continue;
    map[row.category][dept] = row.days;
  }

  // Final fallback: in-file defaults for anything still missing.
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

// ---------------------------------------------------------------------------
// Hookka Expected DD buffer — days between the customer's requested delivery
// date and the internal production target (PACKING anchor). See
// migrations/0007_hookka_dd_buffer.sql for the underlying table.
// ---------------------------------------------------------------------------

export type HookkaDDBuffer = { BEDFRAME: number; SOFA: number };

const DEFAULT_HOOKKA_DD_BUFFER: HookkaDDBuffer = { BEDFRAME: 2, SOFA: 1 };

// Insert default rows IFF the table is empty. Safe to call on every cascade.
export async function ensureHookkaDDBufferSeeded(db: D1Database): Promise<void> {
  const res = await db
    .prepare("SELECT COUNT(*) as n FROM hookka_dd_buffer")
    .first<{ n: number }>();
  if (res && res.n > 0) return;

  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO hookka_dd_buffer (category, days) VALUES (?, ?)",
      )
      .bind("BEDFRAME", DEFAULT_HOOKKA_DD_BUFFER.BEDFRAME),
    db
      .prepare(
        "INSERT OR IGNORE INTO hookka_dd_buffer (category, days) VALUES (?, ?)",
      )
      .bind("SOFA", DEFAULT_HOOKKA_DD_BUFFER.SOFA),
  ]);
}

// Load { BEDFRAME, SOFA } buffer map effective ON or BEFORE `asOfDate`
// (default: today). Single source of truth: hookka_dd_buffer_history.
// Migration 0106 backfilled the legacy hookka_dd_buffer rows with
// effective_from='2020-01-01'.
export async function loadHookkaDDBuffer(
  db: D1Database,
  asOfDate?: string,
): Promise<HookkaDDBuffer> {
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);
  const map: HookkaDDBuffer = { ...DEFAULT_HOOKKA_DD_BUFFER };

  const histRes = await db
    .prepare(
      `SELECT DISTINCT ON (category) category, days
         FROM hookka_dd_buffer_history
        WHERE effective_from <= ?
        ORDER BY category, effective_from DESC, created_at DESC`,
    )
    .bind(asOf)
    .all<{ category: string; days: number }>();
  for (const row of histRes.results ?? []) {
    if (row.category === "BEDFRAME" || row.category === "SOFA") {
      if (Number.isFinite(row.days) && row.days >= 0) {
        map[row.category] = row.days;
      }
    }
  }
  return map;
}

// Look up buffer days for a category with a safe default fallback.
export function hookkaDDBufferFor(
  buffer: HookkaDDBuffer,
  category: string,
): number {
  const normalized = category === "SOFA" ? "SOFA" : "BEDFRAME";
  const v = buffer[normalized];
  if (typeof v === "number" && v >= 0) return v;
  return DEFAULT_HOOKKA_DD_BUFFER[normalized];
}

// ---------------------------------------------------------------------------
// Lead-time settings — single org-scoped flag controlling whether SO confirm
// (and the header-date re-cascade + recalc-all sweep) auto-computes job_card
// dueDates from the per-dept lead times.
//
// Storage: reuses the generic kv_config key/value table (migration 0009) under
// key 'lead-time-settings'. No new table / migration / camelCase column — the
// value is a JSON blob { autoScheduleEnabled: boolean }. Missing row =>
// default TRUE (current behaviour) so existing orgs see no change until they
// flip the toggle on the Planning > Lead Times page.
//
// When autoScheduleEnabled === false, the builder / re-cascade / recalc leave
// dueDate BLANK ("") so staff fill it in manually instead of the scheduler
// "making a mess".
// ---------------------------------------------------------------------------

export type LeadTimeSettings = { autoScheduleEnabled: boolean };

export const LEAD_TIME_SETTINGS_KEY = "lead-time-settings";

export const DEFAULT_LEAD_TIME_SETTINGS: LeadTimeSettings = {
  autoScheduleEnabled: true,
};

// Read the org-scoped lead-time settings from kv_config. Any missing /
// malformed row resolves to the safe default (auto-schedule ON) so the
// SO-confirm path is byte-for-byte unchanged unless the operator explicitly
// turned the toggle OFF.
export async function loadLeadTimeSettings(
  db: D1Database,
): Promise<LeadTimeSettings> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(LEAD_TIME_SETTINGS_KEY)
      .first<{ value: string }>();
    if (!row || typeof row.value !== "string") {
      return { ...DEFAULT_LEAD_TIME_SETTINGS };
    }
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      autoScheduleEnabled:
        typeof parsed.autoScheduleEnabled === "boolean"
          ? parsed.autoScheduleEnabled
          : DEFAULT_LEAD_TIME_SETTINGS.autoScheduleEnabled,
    };
  } catch {
    // Malformed JSON / missing table => fail safe to current behaviour (ON).
    return { ...DEFAULT_LEAD_TIME_SETTINGS };
  }
}

// Upsert the lead-time settings blob into kv_config. Mirrors the kv-config
// route's ON CONFLICT shape (excluded.* uses the real snake_case column name
// because the d1-compat camelCase translator doesn't follow into EXCLUDED.*).
export async function saveLeadTimeSettings(
  db: D1Database,
  settings: LeadTimeSettings,
): Promise<void> {
  const value = JSON.stringify({
    autoScheduleEnabled: settings.autoScheduleEnabled,
  });
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(LEAD_TIME_SETTINGS_KEY, value, now)
    .run();
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
