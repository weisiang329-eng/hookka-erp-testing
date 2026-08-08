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
//   qc_inspections.source_grn_id     the FIRST goods receipt an IQC inspection
//   qc_inspections.source_grn_no     was raised for. Kept singular and kept
//                                    primary so every existing read, index and
//                                    subject link still resolves.
//   qc_inspections.source_grn_ids    EVERY receipt the inspection covers, as a
//   qc_inspections.source_grn_nos    JSON array (owner 2026-08-08: "同一天的话，
//                                    通常是验一次就够了" — one inspection per
//                                    receipt DAY, so it commonly covers more
//                                    than one GRN and the inspector has to be
//                                    told which goods are in front of them).
//   qc_inspections.source_receipt_date  the receipt DAY, and
//   qc_inspections.source_supplier_id   the supplier — together with
//                                    material_family these are the batch key.
//                                    A GRN arriving later the same day looks
//                                    the open inspection up on them and
//                                    ATTACHES instead of raising a second one.
//   qc_inspections.material_family   which family of that day's goods this
//                                    inspection covers (mixed goods raise one
//                                    per family).
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
    // 2026-08-08 (2) — one IQC inspection per receipt DAY, covering several GRNs.
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_ids TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_nos TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_receipt_date TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_supplier_id TEXT",
    // 2026-08-08 (3) — the STORED rhythm. Material degrades in the rack, so the
    // batch drawn for production today is checked whether or not anything was
    // delivered today. Kept as a KIND of RM check rather than a fourth `stage`:
    // `stage` carries a CHECK constraint and a TS union that reach the worker
    // portal, the completion core and every list filter, and a stored-material
    // check behaves exactly like an RM check in all of them.
    "ALTER TABLE qc_templates ADD COLUMN IF NOT EXISTS rm_check_kind TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS rm_check_kind TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_rm_batch_id TEXT",
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_batch_age_days INTEGER",
    // 2026-08-08 (4) — WHY this finished unit was drawn for OQC, frozen at
    // draw time. A sampled unit with no reason on it is a unit the inspector
    // treats as routine, which is the whole thing the weighting exists to stop.
    "ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS sample_reason TEXT",
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_grn ON qc_inspections(source_grn_id)",
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_fg_unit ON qc_inspections(source_fg_unit_id)",
    // The batch-key lookup generation runs on every pass: find the OPEN
    // inspection for (day, supplier, family) so a later receipt attaches.
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_rm_batch ON qc_inspections(source_receipt_date, source_supplier_id, material_family)",
    "CREATE INDEX IF NOT EXISTS idx_qc_inspections_stored ON qc_inspections(rm_check_kind, inspectionDate)",
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
