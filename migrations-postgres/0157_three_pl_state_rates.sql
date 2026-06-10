-- 0157_three_pl_state_rates.sql
-- Per-provider, per-state delivery rate card for 3PL companies.
--
-- The legacy pricing lived as ONE rate pair per provider (drivers.
-- rate_per_trip_sen / rate_per_extra_drop_sen — see migration 0014's naming-
-- misnomer note: `drivers` rows are 3PL COMPANIES) and later per-truck on
-- three_pl_vehicles. Real quotes differ by DESTINATION STATE (a Penang trip
-- and a Johor trip from the same dispatcher cost different money), so this
-- table keys the rate on (provider_id, state).
--
--   state      -- canonical 3-letter code from src/lib/malaysia-states.ts
--                 (KUL, SGR, PNG, JHR, MLK, NSN, PHG, PRK, PLS, KDH, KTN,
--                  TRG, SBH, SWK, PJY, LBN). Writes are validated against
--                 that list — legacy hub shorthand (KL/PG/JB/...) is
--                 resolved on READ, never stored here.
--   rate pair  -- integers in sen. 0/0 = unset (house rule): the provider
--                 does not serve that state / no quote captured yet.
--
-- Rows are lazily seeded (one per canonical state) by the route the first
-- time a provider's card is read, so the UI always sees a fixed 16-row grid.
-- Phase 1 = schema + CRUD + UI only; no cost-calculation path reads this yet.
--
-- NOTE: the route (src/api/routes/three-pl-state-rates.ts) also self-applies
-- this DDL at runtime (CREATE TABLE IF NOT EXISTS) so prod works before this
-- file is applied. Idempotent — re-runs are no-ops.
CREATE TABLE IF NOT EXISTS three_pl_state_rates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'hookka',
  provider_id TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  rate_per_trip_sen INTEGER NOT NULL DEFAULT 0,
  rate_per_extra_drop_sen INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE (provider_id, state)
);

CREATE INDEX IF NOT EXISTS idx_three_pl_state_rates_provider
  ON three_pl_state_rates(provider_id);
