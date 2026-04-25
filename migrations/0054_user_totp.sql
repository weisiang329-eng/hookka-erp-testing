-- ============================================================================
-- Phase C.6 — TOTP 2FA enrollment columns on users.
--
-- A user is "TOTP-enrolled" iff totpEnrolledAt IS NOT NULL. The login flow
-- (src/api/routes-d1/auth.ts) checks this AFTER password verification: if
-- enrolled, the response is { totpRequired: true, userId } instead of a
-- session token. The frontend then prompts for the 6-digit code and POSTs to
-- /api/auth/totp/login-verify.
--
-- Recovery codes are 8 random codes per user, each hashed (SHA-256 + salt)
-- and stored as a JSON array. Plaintext is only returned ONCE at enrollment
-- time — admin docs must spell this out.
-- ============================================================================

ALTER TABLE users ADD COLUMN totpSecret TEXT;
ALTER TABLE users ADD COLUMN totpEnrolledAt TEXT;
ALTER TABLE users ADD COLUMN totpRecoveryHashes TEXT;
