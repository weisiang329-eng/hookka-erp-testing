// ---------------------------------------------------------------------------
// ensure-kpi-tables.ts — runtime self-apply for the KPI module.
//
// Migration files are inert on deploy in this repo; a table reaches prod only
// through an awaited CREATE/ALTER before the first write. See CLAUDE.md.
//
// Two tables, and the split matters:
//
//   kpi_assignments — what Super Admin set for a person. Mutable.
//   kpi_periods     — what was TRUE at month end. Immutable once locked.
//
// Without the second, changing a target retroactively rewrites history and
// last month's score silently moves. A settled month has to keep the target
// it was settled against, or the whole thing is unarguable.
// ---------------------------------------------------------------------------

interface Runner {
  prepare(sql: string): {
    bind(...args: unknown[]): { run(): Promise<unknown> };
    run(): Promise<unknown>;
  };
}

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS kpi_assignments (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL,
     kpi_key      TEXT NOT NULL,
     target       DOUBLE PRECISION NOT NULL,
     weight       DOUBLE PRECISION NOT NULL DEFAULT 0,
     is_active    BOOLEAN NOT NULL DEFAULT TRUE,
     assigned_by  TEXT,
     org_id       TEXT NOT NULL DEFAULT 'hookka',
     created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kpi_assignments_user_kpi
     ON kpi_assignments (user_id, kpi_key)`,
  // The settled month. `locked_at` set means nothing may rewrite it.
  `CREATE TABLE IF NOT EXISTS kpi_periods (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL,
     period       TEXT NOT NULL,
     kpi_key      TEXT NOT NULL,
     target       DOUBLE PRECISION NOT NULL,
     weight       DOUBLE PRECISION NOT NULL,
     actual       DOUBLE PRECISION,
     attainment   DOUBLE PRECISION,
     points       DOUBLE PRECISION,
     detail       TEXT,
     locked_at    TIMESTAMP,
     org_id       TEXT NOT NULL DEFAULT 'hookka',
     created_at   TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kpi_periods_user_period_kpi
     ON kpi_periods (user_id, period, kpi_key)`,
  // One row per (person, month, KPI, checklist item) that has been ticked.
  // The item list itself lives in the code catalogue, so the month's total
  // cannot drift when someone edits a list halfway through — the denominator
  // is whatever the catalogue says today, and the ticks are just facts.
  `CREATE TABLE IF NOT EXISTS kpi_checklist_ticks (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL,
     period       TEXT NOT NULL,
     kpi_key      TEXT NOT NULL,
     item_index   INTEGER NOT NULL,
     done         BOOLEAN NOT NULL DEFAULT TRUE,
     verified_by  TEXT,
     verified_at  TIMESTAMP,
     note         TEXT,
     org_id       TEXT NOT NULL DEFAULT 'hookka',
     created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
     updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kpi_checklist_unique
     ON kpi_checklist_ticks (user_id, period, kpi_key, item_index)`,
  // What the score is WORTH, per person.
  //
  // Owner 2026-08-06: "有一些是只有 KPI 分数、没有钱（属于年尾结算），有一些则是
  // 直接计算钱的." So the money hangs off the PERSON, not off each KPI: several
  // weighted KPIs collapse into one score, and the payout follows that score.
  // Putting an amount on every KPI row would mean five pots that have to be
  // kept adding up to one.
  //
  //   MONTHLY_CASH — pot × score ÷ 100, payable that month.
  //   SCORE_ONLY   — the score is recorded and nothing is paid; settled at
  //                  year end outside this system.
  `CREATE TABLE IF NOT EXISTS kpi_user_settings (
     user_id           TEXT PRIMARY KEY,
     payout_mode       TEXT NOT NULL DEFAULT 'SCORE_ONLY',
     payout_amount_sen INTEGER NOT NULL DEFAULT 0,
     /* Banded ladder as JSON, high rung first. A linear scale gives nobody a
        reason to push 74 to 76; a band means 79 → 80 jumps a whole rung. */
     payout_bands      TEXT NOT NULL DEFAULT '[]',
     org_id            TEXT NOT NULL DEFAULT 'hookka',
     updated_by        TEXT,
     updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
   )`,
  // CREATE TABLE IF NOT EXISTS does NOT add a column to a table that already
  // exists. kpi_user_settings shipped with payout_floor_pct, then the ladder
  // replaced it with payout_bands — and every card 500'd, because the table on
  // prod still had the old shape. The repo warns about exactly this
  // (CLAUDE.md: a new column reaches prod ONLY via ALTER … ADD COLUMN IF NOT
  // EXISTS) and I walked into it anyway. Any column added to a table above
  // needs a line here too.
  `ALTER TABLE kpi_user_settings ADD COLUMN IF NOT EXISTS payout_bands TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE kpi_assignments ADD COLUMN IF NOT EXISTS assigned_by TEXT`,
  `ALTER TABLE kpi_checklist_ticks ADD COLUMN IF NOT EXISTS note TEXT`,
];

let _applied = false;

/**
 * Create the KPI tables if absent.
 *
 * Memoised as a BOOLEAN, never as the in-flight promise: a rejected promise
 * stays cached and one transient failure disables this for the life of the
 * isolate, while a pending one shares a socket db-pg.ts forbids sharing.
 */
export async function ensureKpiTables(db: Runner): Promise<void> {
  if (_applied) return;
  for (const sql of DDL) await db.prepare(sql).run();
  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetKpiTablesMemoForTests(): void {
  _applied = false;
}
