-- D1 mirror of 0146_do_customer_so_snapshot.sql.
--
-- Snapshot the customer's own Sales-Order reference block onto each DO,
-- mirroring how delivery_orders already carries customerPOId (a snapshot of
-- the SO's Customer PO). Old DOs never captured the customer's SO number /
-- reference, so the delivery list "Customer SO" / "Customer Ref" columns are
-- blank on many rows even though the linked sales order HAS them.
--
-- ADDITIVE-ONLY: NULLable columns, no defaults. Existing rows get NULL; the
-- read path falls back to the client-side SO join. POST /api/delivery-orders/
-- backfill-customer-so fills these from each DO's sales order(s).

ALTER TABLE delivery_orders ADD COLUMN customerSOId TEXT;
ALTER TABLE delivery_orders ADD COLUMN customerSO TEXT;
ALTER TABLE delivery_orders ADD COLUMN reference TEXT;
