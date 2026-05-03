-- ---------------------------------------------------------------------------
-- 0069_fabric_split_price_tier.sql
--
-- Split fabric_trackings.priceTier into TWO columns: sofaPriceTier and
-- bedframePriceTier. Reason: the operator wants per-context tiers — one
-- fabric can be P2 in sofa context but P1 in bedframe context. Accessories
-- piggyback on the sofa column.
--
-- Backfill: seed both new columns from the existing priceTier so legacy rows
-- behave identically until the operator splits them in the UI.
--
-- The legacy priceTier column is intentionally KEPT (not dropped) — older
-- code paths still read it. New code reads the split columns; the resolver
-- helper (effectiveTierForCategory) falls back to priceTier when the split
-- columns are NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE fabric_trackings ADD COLUMN sofaPriceTier TEXT
  CHECK (sofaPriceTier IN ('PRICE_1','PRICE_2','PRICE_3'));
ALTER TABLE fabric_trackings ADD COLUMN bedframePriceTier TEXT
  CHECK (bedframePriceTier IN ('PRICE_1','PRICE_2','PRICE_3'));
UPDATE fabric_trackings SET sofaPriceTier = priceTier WHERE sofaPriceTier IS NULL;
UPDATE fabric_trackings SET bedframePriceTier = priceTier WHERE bedframePriceTier IS NULL;
