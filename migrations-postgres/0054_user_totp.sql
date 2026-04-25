-- ============================================================================
-- Phase C.6 — TOTP 2FA columns on users (Postgres mirror of D1
-- migrations/0054_user_totp.sql).
--
-- Idempotent — uses ADD COLUMN IF NOT EXISTS so a partial roll-forward is
-- safe to re-apply. (Postgres 9.6+; Supabase is on 15.x.)
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_recovery_hashes TEXT;
