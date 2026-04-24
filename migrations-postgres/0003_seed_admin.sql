-- ============================================================================
-- HOOKKA ERP — Seed initial SUPER_ADMIN account
--
-- Single bootstrap user. The plaintext password is NOT stored here — for a
-- fresh environment, generate your own hash first:
--
--     npx tsx scripts/hash-admin-password.ts '<pick-a-strong-password>'
--
-- ...and paste it into `passwordHash` below. After seeding, log in once and
-- rotate via POST /api/auth/change-password.
-- ============================================================================

INSERT INTO users (
  id,
  email,
  password_hash,
  role,
  is_active,
  created_at,
  last_login_at,
  display_name
) VALUES (
  'user-admin-001',
  'weisiang329@gmail.com',
  -- Replace before running on a fresh D1; the existing prod DB was already
  -- rotated out-of-band and no longer uses any hash previously committed here.
  'pbkdf2-sha256$100000$000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000',
  'SUPER_ADMIN',
  1,
  '2026-04-22T00:00:00Z',
  NULL,
  'Wei Siang'
);
