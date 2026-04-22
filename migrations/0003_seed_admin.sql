-- ============================================================================
-- HOOKKA ERP — Seed initial SUPER_ADMIN account
--
-- Single bootstrap user. Change the password immediately after first login
-- via POST /api/auth/change-password.
--
--   email    : admin@hookka.local
--   password : admin123
--
-- The hash below was generated with:
--     npx tsx scripts/hash-admin-password.ts admin123
-- (deterministic 16-byte salt used for this seed; regenerate if you want a
-- fresh salt per environment).
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
  'admin@hookka.local',
  'pbkdf2-sha256$100000$a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6$212117de3526e58ba8d73e4406c9a40fc39c36a9eec9d5638628c06cc307c0f9',
  'SUPER_ADMIN',
  1,
  '2026-04-22T00:00:00Z',
  NULL,
  'Administrator'
);
