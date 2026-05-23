-- ---------------------------------------------------------------------------
-- 0132_po_item_category_index.sql — composite index on
-- production_orders(org_id, item_category) to support server-side category
-- filtering on the Production page.
--
-- Wei Siang 2026-05-23: the Category filter on /production was previously
-- a client-side .filter() over the entire `/api/production-orders?fields=minimal`
-- payload. Moving the filter into SQL (?cat=BEDFRAME etc.) cuts the wire
-- payload for narrow-category views. This index lets the new WHERE clause
-- (orgId = ? AND itemCategory = ?) seek directly instead of scanning every
-- PO in the org.
--
-- NOTE: CREATE INDEX CONCURRENTLY MUST run outside a transaction. Run this
-- migration on its own — do NOT batch it inside a BEGIN/COMMIT wrapper.
-- IF NOT EXISTS keeps the migration idempotent across replays.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_po_org_cat
  ON production_orders(org_id, item_category);
