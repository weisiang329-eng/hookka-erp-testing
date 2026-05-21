-- D1 mirror of 0126_invoice_customer_snapshot.sql.

ALTER TABLE invoices ADD COLUMN customerAddress TEXT;
ALTER TABLE invoices ADD COLUMN attention TEXT;
ALTER TABLE invoices ADD COLUMN customerPhone TEXT;
ALTER TABLE invoices ADD COLUMN customerPOId TEXT;

ALTER TABLE credit_notes ADD COLUMN customerAddress TEXT;
ALTER TABLE credit_notes ADD COLUMN attention TEXT;
ALTER TABLE credit_notes ADD COLUMN customerPhone TEXT;
ALTER TABLE credit_notes ADD COLUMN customerState TEXT;

ALTER TABLE debit_notes ADD COLUMN customerAddress TEXT;
ALTER TABLE debit_notes ADD COLUMN attention TEXT;
ALTER TABLE debit_notes ADD COLUMN customerPhone TEXT;
ALTER TABLE debit_notes ADD COLUMN customerState TEXT;
