-- Mirror of migrations-postgres/0179 for the SQLite / D1 path.
ALTER TABLE sales_order_items       ADD COLUMN discount_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consignment_order_items ADD COLUMN discount_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoice_items           ADD COLUMN discount_sen INTEGER NOT NULL DEFAULT 0;

-- quotation_items does not exist in this codebase — skip.
