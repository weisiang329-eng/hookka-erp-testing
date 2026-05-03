-- ---------------------------------------------------------------------------
-- 0067_fabric_price_tier_p3.sql
--
-- Sofa pricing matrix needs three fabric tiers (P1 / P2 / P3) — currently
-- the products page Tier toggle exposes P3 but no fabric can actually be
-- tagged P3 because the original CHECK constraint only allows PRICE_1 and
-- PRICE_2 (mig 0001). Drop and re-create the CHECK so PRICE_3 is also
-- accepted. Existing rows keep whatever tier they already have — this
-- migration is purely a constraint widening, no data backfill needed.
--
-- The frontend type literals (src/pages/sales/create.tsx, src/types/index.ts,
-- src/api/routes/fabric-tracking.ts) are widened in the same Phase 3 commit
-- so the API and UI both surface P3 once this migration applies.
-- ---------------------------------------------------------------------------
ALTER TABLE fabric_tracking DROP CONSTRAINT IF EXISTS fabric_tracking_priceTier_check;
ALTER TABLE fabric_tracking ADD CONSTRAINT fabric_tracking_priceTier_check
  CHECK (priceTier IN ('PRICE_1','PRICE_2','PRICE_3'));
