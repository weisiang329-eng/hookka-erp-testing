-- ---------------------------------------------------------------------------
-- 0103_outstanding_dispatch_recompute.sql
--
-- One-shot mandatory backfill: recompute customers.outstanding_sen so it
-- reflects the new definition introduced by the credit-limit change shipped
-- in this commit.
--
-- Background:
--   Pre-fix, customers.outstanding_sen was ONLY moved by:
--     * Debit Notes  (POSTED → += total_amount)
--     * Credit Notes (POSTED → -= total_amount)
--     * Payments     (RECEIVED → -= allocated amount)
--   It was NEVER bumped by goods leaving the warehouse, so it didn't
--   actually reflect "what the customer owes for dispatched goods" — which
--   is what the new credit-limit gate at DO POST needs to consult.
--
--   Post-fix, the DO DELIVERED transition bumps outstanding_sen by the
--   auto-DRAFT invoice's total_sen (single anchor — see delivery-orders.ts
--   ~L1820 inside the !existingInvoice branch). That makes the field the
--   sum of delivered-DO invoice totals minus payments minus posted CNs
--   plus posted DNs.
--
--   This migration recomputes every customer's outstanding_sen using that
--   new definition so the credit-limit gate has a truthful baseline on
--   first deploy.
--
-- Formula (per customer):
--     outstanding_sen =
--         SUM(invoices.total_sen WHERE delivery_order_id linked to a
--             status='DELIVERED' delivery order)
--       - SUM(invoice_payments.amount_sen against those invoices)
--       - SUM(credit_notes.total_amount WHERE status='POSTED')
--       + SUM(debit_notes.total_amount  WHERE status='POSTED')
--
--   Note: DO total is sourced from invoices.total_sen (DOs themselves
--   have no money column — the DO total IS the auto-invoice total). DOs
--   delivered without a linked invoice (multi-SO DOs that skip the
--   auto-invoice path) do not contribute, matching runtime behaviour.
--
-- Edge cases handled:
--   * Customers with zero history → outstanding_sen = 0 (clamped via
--     GREATEST(...,0); over-allocation rounding can otherwise push the
--     subtotal negative).
--   * Orphan invoices / DNs / CNs whose customer_id no longer exists →
--     ignored (LEFT JOIN with WHERE customer.id IS NOT NULL).
--   * Unposted credit/debit notes (status != 'POSTED') → ignored, matches
--     the runtime guards in credit-notes.ts / debit-notes.ts.
--   * Payments where status != 'RECEIVED' / 'CLEARED' → still counted
--     (matches runtime: payments.ts decrements on insert regardless of
--     subsequent status, the field is "intent to pay against this AR").
--
-- Wrapped in BEGIN / COMMIT so a partial failure doesn't strand half-
-- recomputed values. Idempotent — re-running on the same data produces
-- the same result.
-- ---------------------------------------------------------------------------

BEGIN;

WITH delivered_invoice_totals AS (
  SELECT i.customer_id,
         SUM(i.total_sen)::bigint AS total
    FROM invoices i
    JOIN delivery_orders d ON d.id = i.delivery_order_id
   WHERE i.delivery_order_id IS NOT NULL
     AND d.status = 'DELIVERED'
   GROUP BY i.customer_id
),
delivered_invoice_payments AS (
  SELECT i.customer_id,
         SUM(ip.amount_sen)::bigint AS total
    FROM invoice_payments ip
    JOIN invoices i        ON i.id = ip.invoice_id
    JOIN delivery_orders d ON d.id = i.delivery_order_id
   WHERE i.delivery_order_id IS NOT NULL
     AND d.status = 'DELIVERED'
   GROUP BY i.customer_id
),
posted_credit_notes AS (
  SELECT customer_id,
         SUM(total_amount)::bigint AS total
    FROM credit_notes
   WHERE status = 'POSTED'
   GROUP BY customer_id
),
posted_debit_notes AS (
  SELECT customer_id,
         SUM(total_amount)::bigint AS total
    FROM debit_notes
   WHERE status = 'POSTED'
   GROUP BY customer_id
)
UPDATE customers c
   SET outstanding_sen = GREATEST(
         0,
         COALESCE(dit.total, 0)
       - COALESCE(dip.total, 0)
       - COALESCE(pcn.total, 0)
       + COALESCE(pdn.total, 0)
       )::integer
  FROM (SELECT id FROM customers) ids
  LEFT JOIN delivered_invoice_totals   dit ON dit.customer_id = ids.id
  LEFT JOIN delivered_invoice_payments dip ON dip.customer_id = ids.id
  LEFT JOIN posted_credit_notes        pcn ON pcn.customer_id = ids.id
  LEFT JOIN posted_debit_notes         pdn ON pdn.customer_id = ids.id
 WHERE c.id = ids.id;

COMMIT;
