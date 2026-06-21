-- 0105: effective-dated supplier pricing (SQLite mirror of 0183_postgres).
-- supplier_material_bindings.effectiveFrom = the date THIS price takes effect
-- (current price = the binding row; a price change stamps a new effectiveFrom
-- and appends an audit row to price_histories). price_histories.effectiveFrom =
-- the effective date of that recorded change. Existing rows are NULL and the API
-- falls back to the legacy priceValidFrom / changedDate.
-- (This mirror uses the camelCase column names the route SQL references; the
-- Postgres copy uses snake_case via the column-rename-map.)
ALTER TABLE supplier_material_bindings ADD COLUMN effectiveFrom TEXT;
ALTER TABLE price_histories ADD COLUMN effectiveFrom TEXT;
