// ---------------------------------------------------------------------------
// self-apply.ts — run a module's runtime DDL so that a FAILURE is loud and
// RETRIED, instead of silent and permanent.
//
// Why this exists
// ---------------
// Migrations are inert on deploy in this repo (CLAUDE.md): a new column reaches
// production ONLY through an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` awaited at
// the top of the first write. Every one of those blocks was written as:
//
//     pending = (async () => {
//       for (const sql of stmts) {
//         try { await db.prepare(sql).run(); } catch { /* ignore */ }
//       }
//     })();
//
// Two things compound there. The catch swallows EVERY error unconditionally,
// and the memo is a module-scope promise set once per isolate boot — and it is
// still marked RESOLVED. So if the first write after an isolate boots hits a
// transient DB blip (a cold Hyperdrive pool, which this repo runs a keep-warm
// cron against precisely because it happens), the column is never applied and
// never retried for the life of that isolate. Every subsequent write in that
// isolate then fails on a missing column, and nothing anywhere says why.
//
// Houzs-ERP's `pg-migration-dropped-defaults` COE is the same lesson from the
// other direction: when the runtime path is the ONLY path, it cannot be
// best-effort.
//
// What this does differently
// --------------------------
//   * "already exists" / "does not exist" are EXPECTED — these statements are
//     written to be idempotent, and re-running them is the normal case.
//   * anything else is logged with the statement that failed, so the next
//     person sees a cause instead of a mystery missing column.
//   * a real failure THROWS, so the caller's memo can be cleared and the next
//     request retries. It does not silently continue.
//
// It deliberately does NOT change what the request does next: callers keep the
// existing behaviour of letting the write below surface the schema error with a
// clearer message. The only thing that changes is that the next request gets
// another chance.
// ---------------------------------------------------------------------------

/** Errors these statements are WRITTEN to produce — re-running is the normal case. */
const BENIGN =
  /already exists|does not exist|duplicate (column|object|key|table)|IF NOT EXISTS|IF EXISTS/i;

export function isBenignSelfApplyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return BENIGN.test(msg);
}

// Two prepared-statement shapes exist in this codebase: the D1-compat one that
// can `.run()` directly, and the narrower DbLike interfaces some modules declare
// locally, which require a `.bind()` first. Accept both — the adapter treats
// `.run()` and `.bind().run()` identically for a parameterless statement, and
// forcing 20 call sites to converge on one shape is a bigger change than this
// fix earns.
type Runnable = { run(): Promise<unknown> };
type Bindable = { bind(...args: unknown[]): Runnable };
type Runner = {
  prepare(sql: string): Partial<Runnable> & Partial<Bindable>;
};

function runnableFor(stmt: Partial<Runnable> & Partial<Bindable>): Runnable {
  if (typeof stmt.run === "function") return stmt as Runnable;
  if (typeof stmt.bind === "function") return stmt.bind();
  throw new Error("self-apply: prepared statement can neither run() nor bind()");
}

/**
 * Run one module's self-applied DDL.
 *
 * Every statement is attempted even if an earlier one fails, so a permission
 * problem on one ALTER cannot mask the rest — that part of the original
 * best-effort loop was right and is kept.
 *
 * @throws if any statement failed for a reason that is NOT benign. The caller
 *         is expected to clear its memo in the rejection path so the next
 *         request retries; see `ensurePendingMigrations` in
 *         routes/sales-orders/_helpers.ts for the shape.
 */
export async function runSelfApply(
  db: Runner,
  label: string,
  stmts: string[],
): Promise<void> {
  const failures: { sql: string; msg: string }[] = [];
  for (const sql of stmts) {
    try {
      await runnableFor(db.prepare(sql)).run();
    } catch (err) {
      if (isBenignSelfApplyError(err)) continue;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ sql, msg });
      // Log per statement: which ALTER failed is the whole diagnosis.
      console.error(`[self-apply:${label}] FAILED: ${sql}\n  → ${msg}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `self-apply "${label}" failed on ${failures.length} statement(s); ` +
        `first: ${failures[0].sql} → ${failures[0].msg}`,
    );
  }
}

/**
 * The memo wrapper the call sites need: run once per isolate, but DROP the memo
 * if the round failed so the next request tries again.
 *
 * `getMemo`/`setMemo` rather than an internal map because the existing call
 * sites export their promise (tests and other modules await it), and changing
 * that binding is a bigger blast radius than this fix is worth.
 */
export function memoizeSelfApply(
  getMemo: () => Promise<void> | null,
  setMemo: (p: Promise<void> | null) => void,
  run: () => Promise<void>,
): Promise<void> {
  const hit = getMemo();
  if (hit) return hit;
  const p = run().catch((err) => {
    // The failed round must not be remembered as done — that is the entire bug.
    setMemo(null);
    throw err;
  });
  setMemo(p);
  return p;
}
