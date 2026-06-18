-- ============================================================================
-- HOOKKA ERP — Supplier-payment partial settlement.
-- purchase_invoices.paid_amount_sen tracks the BOOKED MYR already paid (status
-- becomes PARTIAL_PAID between 0 and amount, PAID at full). supplier_payments
-- gains booked_sen (AP cleared, booked MYR), foreign_sen + pay_fx_rate (FX audit);
-- amount_sen now records the actual bank MYR paid.
-- ============================================================================
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS paid_amount_sen INTEGER NOT NULL DEFAULT 0;
UPDATE purchase_invoices SET paid_amount_sen = amount_sen WHERE status = 'PAID' AND paid_amount_sen = 0;

ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS booked_sen INTEGER;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS foreign_sen INTEGER;
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS pay_fx_rate REAL;
UPDATE supplier_payments SET booked_sen = amount_sen WHERE booked_sen IS NULL;
