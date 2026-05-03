-- ---------------------------------------------------------------------------
-- 0068_sofa_combo_rules.sql
--
-- Combo deals for the sofa modules (e.g. 5537-2A, 5537-L, 5537-CNR). Each
-- module is sold as a separate product today; this table lets the company
-- declare "if you buy modules X+Y+Z together, charge this combo price"
-- instead of summing the per-module prices.
--
-- Resolver semantics (mirrors product_prices / customer_product_prices):
--   • Match on (baseModel, componentSizes JSON, fabricTier, customerId)
--     — componentSizes MUST be stored as a canonical-sorted JSON array so
--     two equivalent combos collapse to the same key (e.g. "2A+L" and
--     "L+2A" both store as ["2A","L"]).
--   • customerId NULL = company-wide combo. Set = customer-specific
--     override that wins over the company-wide row when both exist.
--   • fabricTier ANY = applies regardless of fabric tier. PRICE_1 / PRICE_2 /
--     PRICE_3 = applies only when EVERY module in the combo is on that tier
--     (matches fabric_tracking.priceTier values widened by migration 0067).
--   • effectiveFrom is append-only. Newest row where effectiveFrom <= today
--     wins for a given (baseModel, componentSizes, fabricTier, customerId)
--     scope. Future-dated rows are allowed and stay inactive until their
--     effectiveFrom passes.
--   • pricesByHeight is a JSON object {"24":sen, "28":sen, ...} keyed by
--     seat-height code. Same set of heights used elsewhere in the
--     products / sales-order modules (24/28/30/32/35).
--
-- No PUT endpoint — edits = new effective-dated row, same as
-- customer_product_prices (migration 0036) and product_prices (0066).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sofa_combo_rules (
  id TEXT PRIMARY KEY,
  base_model TEXT NOT NULL,                                  -- '5537'
  component_sizes TEXT NOT NULL,                             -- JSON sorted array, e.g. '["2A","L"]'
  fabric_tier TEXT NOT NULL CHECK (fabric_tier IN ('ANY','PRICE_1','PRICE_2','PRICE_3')),
  prices_by_height TEXT NOT NULL,                             -- JSON e.g. '{"24":180000,"28":200000,"30":220000,"32":240000,"35":260000}'
  customer_id TEXT,                                          -- NULL = company-wide, set = customer-specific override
  effective_from TEXT NOT NULL,                              -- YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
  created_by TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scr_base_model ON sofa_combo_rules(base_model);
CREATE INDEX IF NOT EXISTS idx_scr_customer ON sofa_combo_rules(customer_id);
CREATE INDEX IF NOT EXISTS idx_scr_effective ON sofa_combo_rules(effective_from);
