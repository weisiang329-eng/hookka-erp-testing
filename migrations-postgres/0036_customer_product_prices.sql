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
  customer_product_id TEXT NOT NULL,
  base_price_sen INTEGER,           -- NULL = inherit from products.basePriceSen as-of this row's effectiveFrom
  price1_sen INTEGER,              -- NULL = inherit
  seat_height_prices TEXT,          -- JSON; NULL = inherit from products at effectiveFrom
  effective_from TEXT NOT NULL,    -- ISO date YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  created_by TEXT,
  FOREIGN KEY (customer_product_id) REFERENCES customer_products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cpp_parent ON customer_product_prices(customer_product_id);
CREATE INDEX IF NOT EXISTS idx_cpp_effective ON customer_product_prices(effective_from);
