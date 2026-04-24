-- ---------------------------------------------------------------------------
-- 0036_customer_product_prices.sql
--
-- Append-only price history for customer_products. Each row is a dated price
-- snapshot keyed to a parent customer_products assignment. The "current"
-- price is the newest row where effectiveFrom <= today. Future-dated rows
-- are allowed and remain inactive until their effectiveFrom passes.
--
-- Override columns (basePriceSen, price1Sen, seatHeightPrices) are NULL when
-- the history row inherits from products as of that effectiveFrom date.
--
-- Legacy overrides on customer_products stay intact; new writes go here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_product_prices (
  id TEXT PRIMARY KEY,
  customerProductId TEXT NOT NULL,
  basePriceSen INTEGER,           -- NULL = inherit from products.basePriceSen as-of this row's effectiveFrom
  price1Sen INTEGER,              -- NULL = inherit
  seatHeightPrices TEXT,          -- JSON; NULL = inherit from products at effectiveFrom
  effectiveFrom TEXT NOT NULL,    -- ISO date YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  createdBy TEXT,
  FOREIGN KEY (customerProductId) REFERENCES customer_products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cpp_parent ON customer_product_prices(customerProductId);
CREATE INDEX IF NOT EXISTS idx_cpp_effective ON customer_product_prices(effectiveFrom);
