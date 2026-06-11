-- 0143_three_pl_vehicle_dimensions.sql
-- Adds cargo box dimensions (L × W × H in metres) to three_pl_vehicles.
--
-- NAMING NOTE: these columns were added via a runtime self-applying ALTER
-- (unquoted camelCase in the SQL, e.g. boxLengthM) which Postgres folds to
-- all-lowercase (boxlengthm, boxwidthm, boxheightm).  This file uses the
-- folded names so a manual tool apply is a no-op against a database that
-- already received the runtime migration — matching the precedent set by
-- 0141_cnc_templates_total_height.sql and 0156_attendance_photo.sql.
--
-- Read site: SELECT * rows return the folded-lowercase keys; application code
-- reads via dual-key (r.boxLengthM ?? r.boxlengthm) in rowToVehicle().

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxlengthm DOUBLE PRECISION;

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxwidthm DOUBLE PRECISION;

ALTER TABLE three_pl_vehicles
  ADD COLUMN IF NOT EXISTS boxheightm DOUBLE PRECISION;
