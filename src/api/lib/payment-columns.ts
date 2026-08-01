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

let _mig: Promise<void> | null = null;

export function ensurePaymentColumns(db: EnsureDbLike): Promise<void> {
  if (_mig) return _mig;
  _mig = (async () => {
    for (const sql of [
      "ALTER TABLE workers ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER'",
      "ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_name TEXT",
      "ALTER TABLE workers ADD COLUMN IF NOT EXISTS bank_account TEXT",
      "ALTER TABLE payslips ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'TRANSFER'",
      "ALTER TABLE payslips ADD COLUMN IF NOT EXISTS bank_name TEXT",
    ]) {
      await db.prepare(sql).run();
    }
  })();
  return _mig;
}

/** For tests only — reset the module-level cache between cases. */
export function _resetPaymentColumnsMigForTests(): void {
  _mig = null;
}
