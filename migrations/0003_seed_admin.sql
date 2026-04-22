-- ============================================================================
-- HOOKKA ERP — Seed initial SUPER_ADMIN account
--
-- Single bootstrap user. Change the password via POST /api/auth/change-password
-- after first login if desired.
--
--   email    : weisiang329@gmail.com
--   password : Hookka@123
--
-- The hash below was generated with:
--     npx tsx scripts/hash-admin-password.ts 'Hookka@123'
-- Regenerate if you want a fresh salt per environment.
-- ============================================================================

INSERT INTO users (
  id,
  email,
  passwordHash,
  role,
  isActive,
  createdAt,
  lastLoginAt,
  displayName
) VALUES (
  'user-admin-001',
  'weisiang329@gmail.com',
  'pbkdf2-sha256$100000$b412e5147165a4b1db773ac93226c4ee$910bd31c2a5d1dbd8b64ae5b4db0de7eaada6cc65c5bf0194d60f89647586d98',
  'SUPER_ADMIN',
  1,
  '2026-04-22T00:00:00Z',
  NULL,
  'Wei Siang'
);
