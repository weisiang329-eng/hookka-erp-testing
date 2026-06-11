-- ============================================================================
-- 0160 — Repair Scope for Service Orders (partial repairs).
--
-- sales_order_items.repairscope:
--   Per-line repair scope on a Service Order (isServiceOrder=TRUE SOs).
--   JSON: {"preset":"FULL"|"FABRIC"|"FRAME"|"FOAM"|"CUSTOM","depts":[...]}
--   or NULL (= FULL remake, the pre-feature behaviour). Normal sales orders
--   always keep NULL.
--
-- production_orders.repairscope:
--   Snapshot of the source SO line's scope, stamped at PO creation by
--   _shared/production-builder.ts. The cost cascade + delivery pipeline read
--   the scope from the PO (not a join back to sales_order_items) so a
--   post-confirm edit of the SO line can never diverge from the job cards
--   that were actually built.
--
-- ⚠ ADAPTER RULE (BUG-2026-06-10-001 / BUG-2026-06-11-007): these columns
-- are ALSO self-applied at runtime via unquoted camelCase ALTERs
-- ("repairScope"), which Postgres folds to lowercase. This migration file
-- therefore uses the FOLDED name `repairscope` so a tool apply is a no-op
-- on databases where the runtime already created the column. All reads are
-- dual-key (`row.repairScope ?? row.repairscope`).
-- ============================================================================

ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS repairscope TEXT;
ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS repairscope TEXT;
