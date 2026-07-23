-- 0209 — total-height surcharge gets its own stored column.
--
-- Total height = gap + divan + leg; kv_config variants-config.totalHeights
-- prices specific totals (26"=RM 80, 28"=RM 160, …). Until now it was computed
-- only on the typed create page and folded into unit_price_sen with NO column
-- and NO server-side fallback — so the scan / import paths dropped it and it
-- landed in 0 of 125 eligible lines on prod (RM 10,240 uncharged). This makes
-- it the 4th price component stored like the others (base/divan/leg/special),
-- so it is derivable server-side, itemised on the invoice PDF, and editable.
--
-- Runtime self-apply lives in src/api/routes/sales-orders.ts (and invoices.ts).
-- This file is the record; deploy.yml does not replay migrations.

ALTER TABLE sales_order_items       ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consignment_order_items ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items           ADD COLUMN IF NOT EXISTS total_height_price_sen INTEGER NOT NULL DEFAULT 0;
