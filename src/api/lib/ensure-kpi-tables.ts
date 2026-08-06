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
