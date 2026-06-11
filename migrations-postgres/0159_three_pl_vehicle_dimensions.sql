-- 0159_three_pl_vehicle_dimensions.sql
-- Adds cargo box dimensions (L × W × H in FEET — the unit the owner's fleet
-- is quoted in) to three_pl_vehicles. The Fleet form auto-computes Cap (m³)
-- from these (ft³ × 0.028316846592).
--
-- NAMING NOTE: these columns were added via a runtime self-applying ALTER
-- (unquoted camelCase in the SQL, e.g. boxLengthFt) which Postgres folds to
-- all-lowercase (boxlengthft, boxwidthft, boxheightft).  This file uses the
-- folded names so a manual tool apply is a no-op against a database that
-- already received the runtime migration — matching the precedent set by
-- 0156_attendance_photo.sql. See BUG-2026-06-10-001 / BUG-2026-06-11-007.
--
-- Read site: SELECT * rows return the folded-lowercase keys; application code
-- reads via dual-key (r.boxLengthFt ?? r.boxlengthft) in rowToVehicle().

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxlengthft DOUBLE PRECISION;

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxwidthft DOUBLE PRECISION;

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxheightft DOUBLE PRECISION;
