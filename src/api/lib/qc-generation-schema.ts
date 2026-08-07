// ---------------------------------------------------------------------------
// Runtime self-apply for the QC generation columns.
//
// Migrations do NOT auto-apply on deploy in this repo, so a column reaches prod
// only through an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` awaited before the
// first write that needs it. migrations-postgres/0215 carries the same DDL for
// a fresh database (and the template content, which is data and belongs there).
//
// Lives in lib/ rather than in a route because TWO routes write these columns:
// `qc-pending.ts` (generation) and `qc-templates.ts` (the Templates tab writing
// `material_family`). A second copy of the DDL is how one of them ends up
// writing to a column the other never created.
//
// What the columns are for:
//   qc_templates.material_family     which incoming-material family an RM
//                                    checklist covers; goods receipts are
//                                    routed to a checklist by family.
//   qc_inspections.source_grn_id     the goods receipt an IQC inspection was
//   qc_inspections.source_grn_no     raised for — also the idempotency key, so
//                                    the 16:00 run cannot re-raise the 12:00
//                                    receipt.
//   qc_inspections.material_family   which family of that receipt this
//                                    inspection covers (a mixed receipt raises
//                                    one per family).
//   qc_inspections.source_fg_unit_id the finished unit drawn for OQC sampling.
//   qc_inspections.so_spec           the sales-order line that unit was built
//                                    from, frozen at generation time.
//
// All snake_case, so no column-rename-map.json entry is needed; reads come back
// camelCased by the PG adapter's toCamel fallback and are dual-keyed at the
// call sites.
// ---------------------------------------------------------------------------

let ensured = false;

export async function ensureQcGenerationSchema(db: D1Database): Promise<void> {
  if (ensured) return;
  const statements = [
    "ALTER TABLE qc_templates ADD COLUMN IF NOT EXISTS material_family TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_id TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_no TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS material_family TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_fg_unit_id TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS so_spec TEXT",
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_grn ON qc_inspections(source_grn_id)",
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_fg_unit ON qc_inspections(source_fg_unit_id)",
  ];
  // Each statement is caught on its own: one refused ALTER must not take the
  // whole generation run down with it. Generation failing quietly is the exact
  // failure mode this module has already been rebuilt twice to get rid of.
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      console.warn("[qc] generation schema self-apply:", sql, err);
    }
  }
  ensured = true;
}
