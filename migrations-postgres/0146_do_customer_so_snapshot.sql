-- ---------------------------------------------------------------------------
-- 0146_do_customer_so_snapshot.sql — Snapshot the customer's own Sales-Order
-- reference block onto delivery_orders at creation time.
--
-- Problem (Wei Siang 2026-06-03): the delivery list shows "Customer SO" and
-- "Customer Ref" columns, but they are blank on many DOs. delivery_orders
-- already snapshots customer_po_id from its sales order; it never captured the
-- customer's SO number (sales_orders.customer_so / customer_so_id) or the
-- free-text reference (sales_orders.reference). The linked sales orders DO
-- carry these, so the data exists — it just never made it onto the DO.
--
-- This migration is ADDITIVE-ONLY: NULLable columns with no defaults. Existing
-- rows get NULL; the read path already falls back to the client-side SO join.
-- The companion backfill endpoint
-- (POST /api/delivery-orders/backfill-customer-so) sweeps existing rows,
-- copying from the DO's primary sales order or the most-common non-empty value
-- across the DO's items' sales orders.
-- ---------------------------------------------------------------------------

ALTER TABLE delivery_orders
  ADD COLUMN IF NOT EXISTS customer_so_id TEXT,
  ADD COLUMN IF NOT EXISTS customer_so TEXT,
  ADD COLUMN IF NOT EXISTS reference TEXT;
