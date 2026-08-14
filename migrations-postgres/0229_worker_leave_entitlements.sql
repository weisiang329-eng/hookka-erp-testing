-- 0229_worker_leave_entitlements.sql
--
-- Per-worker leave entitlement overrides.
--
-- Before this, entitlement was a hardcoded frontend constant
-- (`LEAVE_ENTITLEMENTS = { ANNUAL: 8, MEDICAL: 14 }` in src/pages/employees.tsx)
-- and a second, DIFFERENT pair of literals in src/api/routes/worker.ts
-- (annual 14, medical 14). Being constants, they could not vary per employee at
-- all — there was no column to vary.
--
-- Both columns are NULLABLE with NO DEFAULT, deliberately:
--
--   NULL  = "no override; use the system default"  → 8 annual / 14 medical,
--           i.e. exactly the behaviour before this migration.
--   value = this worker's own entitlement in days.
--
-- Every existing row is therefore NULL and every existing balance is unchanged.
-- A DEFAULT would make "never set" indistinguishable from "deliberately set to
-- the same number as the default", which is a one-way loss of information.
--
-- ⚠️ REMINDER: this file is INERT on deploy. Deploys do not replay
-- migrations-postgres/*.sql. These columns reach production only via the runtime
-- self-apply in src/api/lib/ensure-leave-columns.ts, which is awaited at the top
-- of every handler that names them. This file is the record and the SQLite test
-- mirror, not the delivery mechanism.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS annual_leave_entitlement_days INTEGER;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS medical_leave_entitlement_days INTEGER;
