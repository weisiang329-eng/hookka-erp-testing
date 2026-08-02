// ---------------------------------------------------------------------------
// Runtime self-apply for the payment-method columns (migration 0210).
//
// Migrations in this repo are INERT on deploy — a .sql file alone never reaches
// production. A new column only exists because some route ran
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and AWAITED it before its first
// write. This is that step for how a worker is paid.
//
// Module-level promise cache so it runs at most once per isolate; additive and
// idempotent, so a re-run costs nothing.
// ---------------------------------------------------------------------------

interface EnsureDbLike {
  prepare(sql: string): { run(): Promise<unknown> };
}

// Cached as a BOOLEAN, not as the in-flight promise.
//
// The old shape was `if (_mig) return _mig` over a cached Promise. Two things
// were wrong with it. A rejected promise stayed cached, so ONE transient DDL
// blip permanently disabled these columns for the life of the isolate — and
// payslip generation awaits this before its first write, so that isolate could
// never produce a payslip again. And a promise holds the socket of the request
// that created it, which db-pg.ts forbids sharing across requests ("Cannot
// perform I/O on behalf of a different request").
//
// A plain flag has neither problem. Every statement is IF NOT EXISTS, so two
// concurrent cold requests both running it is harmless; a failure simply leaves
// the flag unset and the next request retries.
let _applied = false;

export async function ensurePaymentColumns(db: EnsureDbLike): Promise<void> {
  if (_applied) return;
  for (const sql of [
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER'",
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_name TEXT",
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_account TEXT",
    "ALTER TABLE payslips ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER'",
    "ALTER TABLE payslips ADD COLUMN IF NOT EXISTS bank_name TEXT",
    // Outsourced people (owner 2026-08-02). Own staff are unaffected: the flag
    // defaults false and the pay mode defaults to the existing monthly rule, so
    // every current worker keeps computing exactly as before.
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS is_outsource BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS pay_mode TEXT NOT NULL DEFAULT 'MONTHLY'",
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS daily_rate_sen BIGINT NOT NULL DEFAULT 0",
  ]) {
    await db.prepare(sql).run();
  }
  _applied = true;
}

/** For tests only — reset the module-level cache between cases. */
export function _resetPaymentColumnsMigForTests(): void {
  _applied = false;
}
