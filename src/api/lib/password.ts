// ---------------------------------------------------------------------------
// Workers-runtime password helpers (SubtleCrypto only — no node:crypto).
//
// Format on disk (users.passwordHash):
//     pbkdf2-sha256$100000$<hex-salt>$<hex-hash>
//
// This must stay byte-compatible with scripts/hash-admin-password.ts so the
// seed row produced at build-time can be verified at request-time. Both sides
// use PBKDF2-SHA256, 100000 iterations, 16-byte salt, 32-byte derived key.
// ---------------------------------------------------------------------------

const ALGO = "pbkdf2-sha256";
const ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : "0" + hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      // Cast to BufferSource — modern TS types Uint8Array as
      // Uint8Array<ArrayBufferLike> which isn't assignable without a hint.
      salt: salt as BufferSource,
      iterations,
    },
    key,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
}

// Timing-safe equality for two Uint8Arrays of the same length.
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, ITERATIONS, KEY_BYTES);
  return `${ALGO}$${ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [algo, itersStr, saltHex, hashHex] = parts;
  if (algo !== ALGO) return false;
  const iterations = parseInt(itersStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  const salt = hexToBytes(saltHex);
  const expected = hexToBytes(hashHex);
  const actual = await pbkdf2(password, salt, iterations, expected.length);
  return constantTimeEqual(actual, expected);
}
