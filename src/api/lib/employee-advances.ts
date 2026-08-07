// ---------------------------------------------------------------------------
// employee-advances.ts — salary advances, and how they come back out of pay.
//
// Owner 2026-08-07: "员工他们一直在拿 advance，有没有可能在 employee 这边，我可以
// 输入他们拿 advance 的金额和日期？… 一个是在 net pay、total pay 里面扣，另一个
// 可能是可以导出一个我要出钱的 listing 给到我的 HR."
//
// So an advance is CASH ALREADY HANDED OVER, not a pay component. Three
// consequences shape everything below:
//
//  1. It is NOT an earning and NOT a statutory deduction. Gross pay, EPF,
//     SOCSO, EIS and PCB are computed exactly as before — an advance is money
//     the worker has already received against the SAME gross. Folding it into
//     `totalDeductionsSen` would inflate every statutory YTD figure and the
//     payslip would report a contribution that was never made. It is therefore
//     subtracted AFTER the statutory block, and lives in its own column.
//
//  2. The period it belongs to is the month of the DATE the cash was handed
//     over (`advance_date`). No separate "apply to period" field: the owner
//     keys one thing — when he gave the money — and the deduction follows it.
//
//  3. It stays editable until the payroll that recovered it is APPROVED. A
//     typo'd advance on a DRAFT month is just a typo; on an approved month it
//     is a paid-out fact, and rewriting it would move a signed-off net pay.
//
// The table reaches prod ONLY through `ensureAdvanceTables` below — migration
// files are inert on deploy in this repo (CLAUDE.md). Columns are snake_case so
// no `column-rename-map.json` entry is needed; the PG driver hands them back
// camelCased, so every read here is dual-keyed.
// ---------------------------------------------------------------------------

/** The subset of D1Database this module needs (kept narrow so tests can stub). */
interface Runner {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
    run(): Promise<unknown>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
    first<T = unknown>(): Promise<T | null>;
  };
}

/** 'UNSETTLED' while the money is still recoverable/editable; 'SETTLED' once
 *  the payroll run that recovered it has been approved. */
export const ADVANCE_UNSETTLED = "UNSETTLED";
export const ADVANCE_SETTLED = "SETTLED";

export type AdvanceRecord = {
  id: string;
  workerId: string;
  /** YYYY-MM-DD — the day the cash was handed over. Drives the pay period. */
  date: string;
  /** Integer sen. Money is ALWAYS integer sen in this repo. */
  amountSen: number;
  note: string;
  enteredBy: string;
  status: string;
  settledPeriod: string;
  createdAt: string;
};

/** Raw row as the PG driver returns it — camelCased, but SQLite/test stubs and
 *  older paths may hand back the snake_case names, hence the dual keys. */
export type AdvanceRow = {
  id: string;
  workerId?: string | null;
  worker_id?: string | null;
  advanceDate?: string | null;
  advance_date?: string | null;
  amountSen?: number | string | null;
  amount_sen?: number | string | null;
  note?: string | null;
  enteredBy?: string | null;
  entered_by?: string | null;
  status?: string | null;
  settledPeriod?: string | null;
  settled_period?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

export function rowToAdvance(r: AdvanceRow): AdvanceRecord {
  const amount = r.amountSen ?? r.amount_sen ?? 0;
  return {
    id: r.id,
    workerId: r.workerId ?? r.worker_id ?? "",
    date: r.advanceDate ?? r.advance_date ?? "",
    // Postgres hands INTEGER back as a number, but a SUM or a text-typed stub
    // can arrive as a string — coerce so the arithmetic below never becomes
    // string concatenation (which would silently produce nonsense money).
    amountSen: typeof amount === "number" ? amount : Number(amount) || 0,
    note: r.note ?? "",
    enteredBy: r.enteredBy ?? r.entered_by ?? "",
    status: r.status ?? ADVANCE_UNSETTLED,
    settledPeriod: r.settledPeriod ?? r.settled_period ?? "",
    createdAt: r.createdAt ?? r.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Runtime self-apply. A migration FILE is inert on prod — this is the only way
// the table and the payslips column reach the live database, and it is awaited
// at the top of every handler that reads or writes them.
// ---------------------------------------------------------------------------
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS employee_advances (
     id             TEXT PRIMARY KEY,
     worker_id      TEXT NOT NULL,
     advance_date   TEXT NOT NULL,
     amount_sen     INTEGER NOT NULL,
     note           TEXT,
     entered_by     TEXT,
     status         TEXT NOT NULL DEFAULT 'UNSETTLED',
     settled_period TEXT,
     settled_at     TIMESTAMPTZ,
     org_id         TEXT NOT NULL DEFAULT 'hookka',
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at     TIMESTAMPTZ
   )`,
  // Every read is "this worker, this month" or "this month, everyone".
  `CREATE INDEX IF NOT EXISTS idx_employee_advances_date
     ON employee_advances (advance_date)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_advances_worker_date
     ON employee_advances (worker_id, advance_date)`,
  // The generated payslip has to CARRY the figure it was computed with. Without
  // its own column the deduction would only ever be re-derived at read time,
  // and deleting an advance months later would silently move an approved net
  // pay. Legacy rows default to 0, so a payslip generated before this feature
  // keeps exactly the net pay it was approved with.
  `ALTER TABLE payslips ADD COLUMN IF NOT EXISTS advance_deduction_sen INTEGER NOT NULL DEFAULT 0`,
];

let _applied = false;

/**
 * Create the advances table + the payslips column if absent.
 *
 * Memoised as a BOOLEAN, never as the in-flight promise: a rejected promise
 * stays cached and one transient failure disables this for the life of the
 * isolate (the same reasoning as ensure-kpi-tables.ts).
 */
export async function ensureAdvanceTables(db: Runner): Promise<void> {
  if (_applied) return;
  for (const sql of DDL) await db.prepare(sql).run();
  _applied = true;
}

/** For tests — reset the module-level memo between cases. */
export function _resetAdvanceTablesMemoForTests(): void {
  _applied = false;
}

// ---------------------------------------------------------------------------
// Pure maths — the part payroll depends on. Kept free of the DB so both the
// generate path and the projected path can be reasoned about (and tested)
// without a database.
// ---------------------------------------------------------------------------

/** Is this YYYY-MM-DD inside this YYYY-MM pay period? */
export function isInPeriod(date: string, period: string): boolean {
  return (
    /^\d{4}-\d{2}$/.test(period) &&
    typeof date === "string" &&
    date.startsWith(`${period}-`)
  );
}

/**
 * Total advance sen per worker for one pay period.
 *
 * Advances dated OUTSIDE the period are ignored — they were (or will be)
 * recovered by their own month's payroll. Nothing is carried forward
 * automatically; an advance the owner wants recovered in a different month is
 * re-dated, which is a visible edit rather than a hidden rule.
 */
export function sumAdvanceSenByWorker(
  rows: AdvanceRecord[],
  period: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!isInPeriod(r.date, period)) continue;
    if (!r.workerId) continue;
    out.set(r.workerId, (out.get(r.workerId) ?? 0) + (Number(r.amountSen) || 0));
  }
  return out;
}

/**
 * Net pay after the advance is taken back.
 *
 * NOT clamped at zero. If someone drew more than the month earns, the honest
 * figure is negative — they owe the company — and it shows up as a red Net Pay
 * the office has to deal with. Clamping would silently write the difference
 * off, which is exactly the class of bug this codebase keeps paying for.
 *
 * `statutoryDeductionsSen` is the UNCHANGED EPF/SOCSO/EIS/PCB total: the
 * advance is subtracted after it, never added to it.
 */
export function netPayAfterAdvanceSen(
  grossPaySen: number,
  statutoryDeductionsSen: number,
  advanceSen: number,
): number {
  return grossPaySen - statutoryDeductionsSen - (Number(advanceSen) || 0);
}

// ---------------------------------------------------------------------------
// DB read used by BOTH payroll paths (generate + projected) so the finalised
// payslip and the in-progress estimate can never disagree.
// ---------------------------------------------------------------------------

/**
 * Every advance dated inside `period`, grouped per worker.
 *
 * Resilient by design: if the table does not exist yet (a cold isolate whose
 * ensure has not run, or a database that predates this feature) the caller gets
 * an EMPTY map and payroll still generates. A missing advance is a wrong
 * number; a 500 is no payroll at all.
 */
export async function loadPeriodAdvances(
  db: Runner,
  period: string,
): Promise<Map<string, AdvanceRecord[]>> {
  const out = new Map<string, AdvanceRecord[]>();
  if (!/^\d{4}-\d{2}$/.test(period)) return out;
  let rows: AdvanceRow[] = [];
  try {
    const res = await db
      .prepare(
        `SELECT id, worker_id, advance_date, amount_sen, note, entered_by,
                status, settled_period, created_at
           FROM employee_advances
          WHERE advance_date LIKE ?
          ORDER BY advance_date, id`,
      )
      .bind(`${period}-%`)
      .all<AdvanceRow>();
    rows = res.results ?? [];
  } catch (e) {
    console.warn("[employee-advances] period read skipped:", e);
    return out;
  }
  for (const raw of rows) {
    const rec = rowToAdvance(raw);
    if (!rec.workerId) continue;
    const arr = out.get(rec.workerId) ?? [];
    arr.push(rec);
    out.set(rec.workerId, arr);
  }
  return out;
}

/**
 * Lock (or unlock) a period's advances.
 *
 * Called from the payroll bulk-status flip: approving a month makes its
 * advances a signed-off fact, so they stop being editable; putting the month
 * back to DRAFT hands them back. Best-effort — a failure here must never fault
 * the payroll approval itself, which is the operation the operator asked for.
 */
export async function markAdvancesSettled(
  db: Runner,
  period: string,
  settled: boolean,
): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(period)) return;
  try {
    if (settled) {
      await db
        .prepare(
          `UPDATE employee_advances
              SET status = 'SETTLED', settled_period = ?, settled_at = now(), updated_at = now()
            WHERE advance_date LIKE ? AND status <> 'SETTLED'`,
        )
        .bind(period, `${period}-%`)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE employee_advances
              SET status = 'UNSETTLED', settled_period = NULL, settled_at = NULL, updated_at = now()
            WHERE advance_date LIKE ? AND status = 'SETTLED'`,
        )
        .bind(`${period}-%`)
        .run();
    }
  } catch (e) {
    console.warn("[employee-advances] settle skipped:", e);
  }
}

/** Sum of a worker's advance list, in sen. */
export function totalAdvanceSen(list: AdvanceRecord[] | undefined): number {
  if (!list || list.length === 0) return 0;
  let sum = 0;
  for (const a of list) sum += Number(a.amountSen) || 0;
  return sum;
}
