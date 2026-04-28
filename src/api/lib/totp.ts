// ---------------------------------------------------------------------------
// RFC 6238 TOTP — Workers-runtime implementation (SubtleCrypto only).
//
// Algorithm: HOTP-SHA1 (RFC 4226) with a 30-second time step and 6-digit
// codes. This is what every authenticator app on the planet expects
// (Google Authenticator, Authy, 1Password, Microsoft Authenticator, …).
//
// Format on disk (users.totpSecret):
//     base32-encoded random bytes, 32 chars (≈ 160 bits of entropy).
//     Stored *unencrypted* — same trust boundary as the password hash. If
//     this column leaks, the attacker has the password hash already and
//     can mint codes; protect the DB at the row level (RLS / column-level
//     KMS) when threat model warrants.
//
// Recovery codes:
//     8 codes per user, 10 chars each (alphanumeric, no ambiguous glyphs).
//     Stored as a JSON array of SHA-256 hashes WITH a per-user salt prepended
//     ('recover:<userId>:<code>'). Plaintext returned ONCE at enrollment;
//     admin-side documentation must spell that out for the user.
//
// Why not bcrypt for recovery codes?
//   * bcrypt is not available in the Workers runtime (no Node crypto).
//   * Recovery codes are high-entropy (~52 bits) so SHA-256 + salt is fine —
//     dictionary attacks aren't viable against 60-bit random strings.
// ---------------------------------------------------------------------------

// --- base32 (RFC 4648, no padding) -----------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx < 0) {
      throw new Error(`Invalid base32 char: ${c}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// --- secret + recovery generation ------------------------------------------

/**
 * Generate a fresh TOTP secret. Returns a base32-encoded string suitable for
 * both `users.totpSecret` storage and the `otpauth://` enrollment URL.
 *
 * 20 random bytes → 32 base32 chars (after the implicit 0-pad on the last
 * byte). This matches what Google Authenticator generates when you tap
 * "scan QR" → 160 bits of entropy.
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

const RECOVERY_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid OCR confusion

/**
 * Generate `n` recovery codes (default 8) and their hashes. The plaintext
 * is shown to the user ONCE at enrollment; the hashes are persisted in
 * users.totpRecoveryHashes (JSON array). Each code is 10 chars from a
 * confusion-free alphabet (~50 bits of entropy).
 *
 * The hashing is salted per-user via the `userId` argument: even if two
 * users somehow generated the same code, the stored hashes differ.
 */
export async function generateRecoveryCodes(
  userId: string,
  n: number = 8,
): Promise<{ plaintext: string[]; hashes: string[] }> {
  const plaintext: string[] = [];
  for (let i = 0; i < n; i++) {
    const buf = new Uint8Array(10);
    crypto.getRandomValues(buf);
    let s = "";
    for (let j = 0; j < buf.length; j++) {
      s += RECOVERY_ALPHABET[buf[j] % RECOVERY_ALPHABET.length];
    }
    plaintext.push(s);
  }
  const hashes = await Promise.all(
    plaintext.map((code) => hashRecoveryCode(userId, code)),
  );
  return { plaintext, hashes };
}

export async function hashRecoveryCode(
  userId: string,
  code: string,
): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`recover:${userId}:${code.trim().toUpperCase()}`),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a user-submitted recovery code against the stored hash list.
 * Returns the index of the matching hash (caller is expected to remove it
 * from the list — recovery codes are single-use), or -1 if no match.
 *
 * Constant-time compare: we compare every stored hash even after a hit so
 * the response time doesn't leak which code matched.
 */
export async function verifyRecoveryCode(
  userId: string,
  code: string,
  storedHashes: string[],
): Promise<number> {
  const target = await hashRecoveryCode(userId, code);
  let foundIdx = -1;
  for (let i = 0; i < storedHashes.length; i++) {
    let diff = 0;
    if (storedHashes[i].length === target.length) {
      for (let j = 0; j < target.length; j++) {
        diff |= storedHashes[i].charCodeAt(j) ^ target.charCodeAt(j);
      }
      if (diff === 0 && foundIdx === -1) foundIdx = i;
    }
  }
  return foundIdx;
}

// --- HOTP / TOTP -----------------------------------------------------------

async function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = 6,
): Promise<string> {
  // Counter as 8-byte big-endian (RFC 4226 §5.1).
  const counterBuf = new Uint8Array(8);
  // JS bitwise ops are 32-bit; counter rarely exceeds 2^53 so split is fine.
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, Uint8Array.from(counterBuf)),
  );

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = sig[sig.length - 1] & 0x0f;
  const binCode =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  const mod = 10 ** digits;
  const code = (binCode % mod).toString().padStart(digits, "0");
  return code;
}

/**
 * Verify a 6-digit TOTP code against the user's secret. The window (`±1`
 * step by default = ±30 seconds) absorbs minor clock drift between client
 * and server.
 *
 * Constant-time compare: we always evaluate every step in the window even
 * after a hit so the response time doesn't leak which step matched.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  windowSteps: number = 1,
): Promise<boolean> {
  const trimmed = (code || "").trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  let secret: Uint8Array;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const step = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidate = await hotp(secret, step + w, 6);
    let diff = 0;
    for (let i = 0; i < 6; i++) {
      diff |= candidate.charCodeAt(i) ^ trimmed.charCodeAt(i);
    }
    if (diff === 0) ok = true;
  }
  return ok;
}

/**
 * Build the `otpauth://totp/...` enrollment URL the user scans into their
 * authenticator. The `issuer` shows up as the account label in the app; the
 * `email` disambiguates between multiple accounts under the same issuer.
 *
 * Spec: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export function enrollUrl(
  email: string,
  secretBase32: string,
  issuer: string = "Hookka Manufacturing ERP",
): string {
  const issuerEnc = encodeURIComponent(issuer);
  const labelEnc = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${labelEnc}?${params.toString()}&issuer=${issuerEnc}`;
}

// --- helpers re-exported for callers that need raw HOTP --------------------

export const _internals = { hotp, base32Encode, base32Decode };
