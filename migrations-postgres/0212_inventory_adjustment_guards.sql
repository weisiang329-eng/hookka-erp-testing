-- Inventory adjustment write-time invariants.
-- NOT VALID preserves visibility of historical drift while PostgreSQL still
-- enforces each constraint for every new or updated row. The application posts
-- all ledger and balance statements through one transaction-backed DB.batch(),
-- so a concurrent over-consumption rolls the whole adjustment back.

ALTER TABLE raw_materials
  ADD CONSTRAINT raw_materials_balance_nonnegative
  CHECK (balance_qty >= 0) NOT VALID;

ALTER TABLE wip_items
  ADD CONSTRAINT wip_items_stock_nonnegative
  CHECK (stock_qty >= 0) NOT VALID;

ALTER TABLE fg_batches
  ADD CONSTRAINT fg_batches_remaining_nonnegative
  CHECK (remaining_qty >= 0) NOT VALID;

ALTER TABLE rm_batches
  ADD CONSTRAINT rm_batches_remaining_nonnegative
  CHECK (remaining_qty >= 0) NOT VALID;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_nonzero_qty
  CHECK (qty_delta <> 0) NOT VALID;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_direction_matches_qty
  CHECK (
    (qty_delta > 0 AND direction = 'IN') OR
    (qty_delta < 0 AND direction = 'OUT')
  ) NOT VALID;

ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_cost_nonnegative
  CHECK (unit_cost_sen >= 0 AND total_cost_sen >= 0) NOT VALID;
