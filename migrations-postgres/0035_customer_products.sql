-- ---------------------------------------------------------------------------
-- 0035_customer_products.sql
--
-- Per-customer SKU master with optional price overrides.
--   - customerId + productId is unique (one assignment row per pair)
--   - override columns (basePriceSen, price1Sen, seatHeightPrices) are
--     NULL when the customer inherits the global product price.
--   - seatHeightPrices stored as JSON TEXT (same shape as products.seatHeightPrices)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_products (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  base_price_sen INTEGER,           -- NULL = inherit from products.basePriceSen
  price1_sen INTEGER,              -- NULL = inherit from products.price1Sen
  seat_height_prices TEXT,          -- JSON array (same shape as products.seatHeightPrices); NULL = inherit
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  updated_at TEXT,
  UNIQUE(customer_id, product_id),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_products_customer ON customer_products(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_products_product ON customer_products(product_id);
