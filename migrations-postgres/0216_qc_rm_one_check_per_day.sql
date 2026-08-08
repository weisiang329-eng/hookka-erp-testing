-- ============================================================================
-- Migration 0216 — IQC is one inspection per receipt DAY, not per goods receipt.
--
-- OWNER 2026-08-08, correcting the per-GRN rule shipped the same day in
-- 56abaaf0 / 29aa30f7:
--
--   "同一天的话，通常是验一次就够了"
--   (and originally: "可能是一张 PI 或者同一天进来的货，我们只需要检查一次")
--
-- 0215 read that as "the GRN is the batch", so two receipts of the same goods
-- on one day raised two inspections. The inspector walks to the same pallet
-- once; they should answer one checklist and both receipt numbers should be on
-- it. The batch is (receipt DAY × supplier × material family).
--
-- TWO SUPPLIERS ON ONE DAY STAY TWO INSPECTIONS. Two suppliers is two batches
-- with two independent risks and two different corrective actions — a claim
-- goes back to a supplier, not to a Tuesday — and one blended PASS would hide
-- which delivery was the bad one. That is the same argument that already keeps
-- the families apart, applied to the other axis of the batch.
--
-- NOTE: this file is INERT until `npm run db:migrate:supabase` is run.
-- `ensureQcGenerationSchema()` (src/api/lib/qc-generation-schema.ts) self-applies
-- the SAME columns at runtime, which is what actually gets them onto prod.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Columns
--
-- `source_grn_id` / `source_grn_no` stay SINGULAR and stay the FIRST receipt of
-- the batch, so every existing read, index and subject link keeps resolving.
-- The full list lives beside them. Storing the list on the row (rather than
-- pointing at "the day + the family" and re-deriving the receipts in the UI)
-- is deliberate: the inspection is a RECORD, and a record that has to re-run a
-- query to say what it was about stops being true the moment a GRN is
-- cancelled, back-dated or re-supplied.
-- ----------------------------------------------------------------------------
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_ids      TEXT; -- JSON array of GRN ids
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_grn_nos      TEXT; -- JSON array of GRN numbers
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_receipt_date TEXT; -- 'YYYY-MM-DD'
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_supplier_id  TEXT;

-- The batch-key lookup generation runs on every pass: find the OPEN inspection
-- for (day, supplier, family) so a receipt confirmed later the same day
-- ATTACHES to it instead of raising a second one.
CREATE INDEX IF NOT EXISTS idx_qc_inspections_rm_batch
  ON qc_inspections(source_receipt_date, source_supplier_id, material_family);

-- ----------------------------------------------------------------------------
-- B. Backfill the batch key onto rows raised under the per-GRN rule.
--
-- Without this, an inspection raised this morning under the old rule is
-- invisible to the batch lookup, and the afternoon's receipt raises a second
-- inspection for goods that already have one open. Every UPDATE is guarded on
-- IS NULL so re-running changes nothing and an owner edit is never clobbered.
--
-- (Generation also derives the key from the named receipt at runtime when these
-- columns are null, so a database where this file has not been run still folds
-- correctly — this only makes the lookup indexable rather than inferred.)
-- ----------------------------------------------------------------------------
UPDATE qc_inspections i
   SET source_receipt_date = substr(g.receive_date::text, 1, 10),
       source_supplier_id  = COALESCE(i.source_supplier_id, g.supplier_id)
  FROM grns g
 WHERE i.source_grn_id = g.id
   AND i.stage = 'RM'
   AND i.source_receipt_date IS NULL
   AND g.receive_date IS NOT NULL;

UPDATE qc_inspections
   SET source_grn_ids = json_build_array(source_grn_id)::text,
       source_grn_nos = json_build_array(source_grn_no)::text
 WHERE stage = 'RM'
   AND source_grn_id IS NOT NULL
   AND source_grn_ids IS NULL;
