-- Belt-and-suspenders guard for BUG-2026-07-14-006.
-- The route checks first for a friendly 409; this partial unique index closes
-- the concurrent read->write window even when requests use different keys.
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT org_id, delivery_order_id
    FROM invoices
    WHERE status <> 'CANCELLED'
      AND delivery_order_id IS NOT NULL
      AND delivery_order_id <> ''
    GROUP BY org_id, delivery_order_id
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add active-invoice uniqueness: % delivery order(s) still have multiple non-cancelled invoices. Run the duplicate-invoice planner and resolve them first.',
      duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_one_active_per_do
  ON invoices (org_id, delivery_order_id)
  WHERE status <> 'CANCELLED'
    AND delivery_order_id IS NOT NULL
    AND delivery_order_id <> '';
