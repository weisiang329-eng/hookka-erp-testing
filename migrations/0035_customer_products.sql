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
  customerId TEXT NOT NULL,
  productId TEXT NOT NULL,
  basePriceSen INTEGER,           -- NULL = inherit from products.basePriceSen
  price1Sen INTEGER,              -- NULL = inherit from products.price1Sen
  seatHeightPrices TEXT,          -- JSON array (same shape as products.seatHeightPrices); NULL = inherit
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT,
  UNIQUE(customerId, productId),
  FOREIGN KEY (customerId) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customer_products_customer ON customer_products(customerId);
CREATE INDEX IF NOT EXISTS idx_customer_products_product ON customer_products(productId);
