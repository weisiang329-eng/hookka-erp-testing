// ============================================================================
// hash-admin-password.ts
//
// CLI helper to produce a password hash in the exact format stored in
// `users.passwordHash`. Use this when seeding or manually resetting an admin
// account. The Workers runtime produces the same format via
// src/api/lib/password.ts (SubtleCrypto path) — both sides agree on:
//
//   algo         : PBKDF2-SHA256
//   iterations   : 100000
//   salt length  : 16 bytes
//   key length   : 32 bytes
//   stored form  : pbkdf2-sha256$100000$<hex-salt>$<hex-hash>
//
// Usage:
//     npx tsx scripts/hash-admin-password.ts <password>
// ============================================================================

import * as crypto from "node:crypto";

const ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function main(): void {
  const password = process.argv[2];
  if (!password) {
    console.error("Usage: tsx scripts/hash-admin-password.ts <password>");
    process.exit(1);
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, "sha256");

  const stored = `pbkdf2-sha256$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
  console.log(stored);
}

main();
