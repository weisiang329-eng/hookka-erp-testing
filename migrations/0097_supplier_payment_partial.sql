-- Mirror of migrations-postgres/0172 for the rename-map scanner.
ALTER TABLE purchase_invoices ADD COLUMN paid_amount_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE supplier_payments ADD COLUMN booked_sen INTEGER;
ALTER TABLE supplier_payments ADD COLUMN foreign_sen INTEGER;
ALTER TABLE supplier_payments ADD COLUMN pay_fx_rate REAL;
