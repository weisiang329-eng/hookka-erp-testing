// ---------------------------------------------------------------------------
// Runtime self-apply for the PCB tax-profile columns (migration 0229).
//
// Migrations in this repo are INERT on deploy — a .sql file alone never reaches
// production. A new column exists only because some route ran
// `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and AWAITED it before its first
// write. This is that step for PCB (BUG-2026-08-13-121).
//
// Every column here is NULLABLE with NO default, and that is the whole design:
// NULL means "the employee has not declared this", which is a different thing
// from any value we could pick. Defaulting `tax_residency` to 'RESIDENT' would
// under-withhold from a non-resident by 30% of gross; defaulting
// `tax_category` to 'SINGLE' would over-withhold from a married sole earner.
// Both are somebody's money.
//
// `payslips.pcb_status` is likewise nullable, and NULL on the rows generated
// before this change is correct: PCB was not computed for them, and stamping
// them 'DISABLED' or 'COMPUTED' now would be a claim about a document that was
// already issued.
//
// Memoised as a BOOLEAN, never as the in-flight promise (bug class C9).
// ---------------------------------------------------------------------------

interface EnsureDbLike {
  prepare(sql: string): { run(): Promise<unknown> };
}

let _applied = false;

export async function ensurePayrollTaxColumns(db: EnsureDbLike): Promise<void> {
  if (_applied) return;
  for (const sql of [
    // 'RESIDENT' | 'NON_RESIDENT'. NULL = not declared.
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS tax_residency TEXT",
    // 'SINGLE' | 'MARRIED_SPOUSE_NOT_WORKING' | 'MARRIED_SPOUSE_WORKING'.
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS tax_category TEXT",
    // Annual child relief in SEN — the relief, not a headcount (LHDN's per-child
    // amount depends on the child, not the count). NULL = not declared; 0 is a
    // legitimate declared value meaning no children.
    "ALTER TABLE workers ADD COLUMN IF NOT EXISTS tax_child_relief_sen BIGINT",
    // How the pcb_sen on the row beside it was arrived at:
    // 'DISABLED' | 'COMPUTED' | 'ZERO_PROVEN' | 'UNKNOWN'. NULL = generated
    // before PCB was computed at all.
    "ALTER TABLE payslips ADD COLUMN IF NOT EXISTS pcb_status TEXT",
  ]) {
    await db.prepare(sql).run();
  }
  _applied = true;
}

/** For tests only — reset the module-level cache between cases. */
export function _resetPayrollTaxColumnsMigForTests(): void {
  _applied = false;
}
