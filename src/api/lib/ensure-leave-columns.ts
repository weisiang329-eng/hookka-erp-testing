import type { Env } from "../worker";
import { runSelfApply, memoizeSelfApply } from "./self-apply";

// ---------------------------------------------------------------------------
// ensure-leave-columns.ts — runtime self-apply of the per-worker leave
// entitlement overrides.
//
// Migrations are INERT on deploy in this repo (CLAUDE.md): the canonical DDL is
// migrations-postgres/0229_worker_leave_entitlements.sql, but the column reaches
// PRODUCTION only through this awaited runtime ensure. It must be awaited at the
// top of any handler that READS or WRITES these columns, before the first
// statement that names them — a `SELECT` of a column that does not exist is just
// as fatal as an `INSERT`.
//
// Both columns are added NULLABLE with NO default, and that is load-bearing:
// NULL means "no override", which `resolveEntitlementDays` maps to the existing
// 8 / 14 defaults. Every row that exists today therefore keeps exactly the
// entitlement it has today. Giving these columns a DEFAULT would be the same
// change with a worse failure mode — it would look identical while making
// "unset" and "deliberately set to 8" indistinguishable forever.
//
// Memoised through `memoizeSelfApply`, which DROPS the memo when the round
// fails, so a transient DDL blip on the first write after an isolate boots is
// retried on the next request instead of being remembered as done for the life
// of the isolate. Caching the promise itself is bug class C9.
// ---------------------------------------------------------------------------

const LEAVE_COLUMN_STATEMENTS: readonly string[] = [
  "ALTER TABLE workers ADD COLUMN IF NOT EXISTS annual_leave_entitlement_days INTEGER",
  "ALTER TABLE workers ADD COLUMN IF NOT EXISTS medical_leave_entitlement_days INTEGER",
];

let leaveColumnsPromise: Promise<void> | null = null;

export function ensureLeaveEntitlementColumns(
  db: Env["Variables"]["DB"],
): Promise<void> {
  return memoizeSelfApply(
    () => leaveColumnsPromise,
    (p) => {
      leaveColumnsPromise = p;
    },
    () =>
      runSelfApply(db, "leave-entitlement-columns", [...LEAVE_COLUMN_STATEMENTS]),
  );
}

/** Exported for the guard test, which asserts both columns are self-applied. */
export const LEAVE_ENTITLEMENT_SELF_APPLY_STATEMENTS = LEAVE_COLUMN_STATEMENTS;
