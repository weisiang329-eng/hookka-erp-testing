// ---------------------------------------------------------------------------
// Shared auth helpers — thin wrappers around SubtleCrypto for simple hashing
// where the PBKDF2 machinery in password.ts is overkill (e.g. 4-digit worker
// PINs on the shop floor).
//
// hashPin: SHA-256 over UTF-8 bytes, hex-encoded. Not salted — PIN space is
// only 10^4 and rainbow tables are trivial, so this is not "real" auth; it
// just keeps raw PINs from sitting in D1 in cleartext. Real worker auth
// should migrate to PBKDF2 + per-worker salt (reuse password.ts) when the
// shop floor moves beyond convenience login.
// ---------------------------------------------------------------------------
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export async function hashPin(plain: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(plain));
  return bytesToHex(new Uint8Array(digest));
}

// Detect whether a stored `worker_pins.pin` value is still cleartext (4 digit
// numeric) vs. an already-hashed SHA-256 hex (64 lowercase hex chars). Used
// during login so legacy rows auto-upgrade on successful auth.
export function isPinHashed(stored: string): boolean {
  return /^[0-9a-f]{64}$/.test(stored);
}
