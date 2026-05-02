-- ---------------------------------------------------------------------------
-- 0066_product_prices.sql
--
-- Append-only price history for the master products listing. Mirrors the
-- shape of customer_product_prices (migration 0036) one level higher:
-- each row is a dated price snapshot keyed to a product. The "current"
-- master price is the newest row where effectiveFrom <= today. Future-
-- dated rows are allowed and stay inactive until their effectiveFrom
-- passes — this is what lets the company schedule a price hike for
-- e.g. 2026-06-01 in advance.
--
-- Override columns (basePriceSen, price1Sen, seatHeightPrices) are NULL
-- when the row inherits from the products table itself as of that
-- effectiveFrom date. In practice every row written by the UI will have
-- concrete prices, but the NULL semantics are kept symmetric with
-- customer_product_prices so the same resolver pattern works.
--
-- The legacy columns on the products table (basePriceSen, price1Sen,
-- seatHeightPrices) stay as-is and act as the fallback when no row
-- in product_prices is yet effective. New writes always go here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_prices (
  id TEXT PRIMARY KEY,
  productId TEXT NOT NULL,
  basePriceSen INTEGER,           -- NULL = inherit from products.basePriceSen
  price1Sen INTEGER,              -- NULL = inherit from products.price1Sen
  seatHeightPrices TEXT,          -- JSON; NULL = inherit from products
  effectiveFrom TEXT NOT NULL,    -- ISO date YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  createdBy TEXT,
  FOREIGN KEY (productId) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pp_product ON product_prices(productId);
CREATE INDEX IF NOT EXISTS idx_pp_effective ON product_prices(effectiveFrom);
