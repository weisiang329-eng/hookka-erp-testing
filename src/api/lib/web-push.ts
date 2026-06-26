// ============================================================
// Web Push — Workers/edge-compatible VAPID + aes128gcm sender.
//
// The Node `web-push` npm package depends on Node's `crypto`/`https` modules
// and does NOT run on Cloudflare Workers. This is a hand-rolled implementation
// using ONLY the Web Crypto API (crypto.subtle) + fetch — zero Node built-ins —
// so it runs unchanged on the Workers runtime.
//
// It implements:
//   - VAPID (RFC 8292): an ES256 JWT signed with the application server's
//     private key, presented in the Authorization header so the push service
//     trusts the request.
//   - Message encryption (RFC 8291 / aes128gcm content-encoding): an ephemeral
//     ECDH key agreement with the subscription's p256dh public key, HKDF to
//     derive the content-encryption key + nonce, then AES-128-GCM over the
//     padded plaintext, framed with the aes128gcm header (salt + record size +
//     ephemeral public key).
//
// References:
//   - https://datatracker.ietf.org/doc/html/rfc8291
//   - https://datatracker.ietf.org/doc/html/rfc8188 (aes128gcm framing)
//   - https://datatracker.ietf.org/doc/html/rfc8292 (VAPID)
//   - approach mirrors @block65/webcrypto-web-push (Workers-compatible)
// ============================================================

// All byte helpers are typed `Uint8Array<ArrayBuffer>` (NOT the default
// `Uint8Array<ArrayBufferLike>`) so they satisfy the `BufferSource` parameters
// of crypto.subtle / fetch under the strict lib.dom: a plain `new Uint8Array(n)`
// is always backed by a concrete (non-shared) ArrayBuffer, so this annotation is
// sound and avoids a cast at every Web Crypto call site.

// ---- base64url helpers (no padding) ----
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  // TextEncoder.encode returns Uint8Array<ArrayBufferLike>; copy into a fresh
  // ArrayBuffer-backed view so the type is concrete for BufferSource params.
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length);
  out.set(enc);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---- types ----
export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string; // base64url — the UA public key (uncompressed P-256 point)
  auth: string; // base64url — 16-byte auth secret
};

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
};

export type VapidConfig = {
  publicKey: string; // base64url uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url raw 32-byte scalar (the JWK `d`)
  subject: string; // mailto: or https: contact
};

export type SendResult = {
  endpoint: string;
  ok: boolean;
  status: number;
  // gone === true when the push service reports the subscription is dead
  // (404/410) and the caller should prune it from the DB.
  gone: boolean;
  error?: string;
};

// ============================================================
// VAPID JWT — ES256 signed with the application server private key.
// ============================================================
async function importVapidSigningKey(privateKeyB64url: string, publicKeyB64url: string): Promise<CryptoKey> {
  // Reconstruct the JWK from the raw private scalar `d` + the public point x/y.
  const pub = b64urlToBytes(publicKeyB64url); // 0x04 || X(32) || Y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  }
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64url,
    x,
    y,
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function buildVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  // 12h expiry (RFC 8292 caps at 24h; keep comfortably under).
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const payload = { aud: audience, exp, sub: vapid.subject };
  const signingInput = `${bytesToB64url(utf8(JSON.stringify(header)))}.${bytesToB64url(
    utf8(JSON.stringify(payload)),
  )}`;
  const key = await importVapidSigningKey(vapid.privateKey, vapid.publicKey);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput),
  );
  // crypto.subtle returns the raw r||s (64 bytes) JOSE form — exactly what JWS wants.
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
}

// ============================================================
// aes128gcm payload encryption (RFC 8291 + RFC 8188).
// ============================================================
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptPayload(
  sub: PushSubscriptionKeys,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlToBytes(sub.p256dh); // 65-byte uncompressed point
  const authSecret = b64urlToBytes(sub.auth); // 16 bytes

  // Ephemeral server ECDH keypair.
  const serverKp = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const serverPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKp.publicKey),
  ); // 65 bytes

  // ECDH shared secret with the UA public key.
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey },
      serverKp.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3 — derive the IKM via HKDF keyed by the auth secret, with the
  // key_info "WebPush: info\0" || ua_public || server_public.
  const keyInfo = concat(
    utf8("WebPush: info\0"),
    uaPublic,
    serverPublicRaw,
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  // 16-byte random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Content encryption key (16 bytes) + nonce (12 bytes).
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // Single-record body: plaintext || 0x02 (last-record delimiter), then AEAD.
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  // aes128gcm header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(server pubkey 65).
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPublicRaw.length);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = serverPublicRaw.length; // 65
  header.set(serverPublicRaw, 21);

  return concat(header, ciphertext);
}

// ============================================================
// Send a single push message to one subscription.
// ============================================================
export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: PushPayload,
  vapid: VapidConfig,
): Promise<SendResult> {
  let audience: string;
  try {
    const u = new URL(sub.endpoint);
    audience = `${u.protocol}//${u.host}`;
  } catch {
    return { endpoint: sub.endpoint, ok: false, status: 0, gone: false, error: "bad endpoint" };
  }

  try {
    const body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
    const jwt = await buildVapidJwt(audience, vapid);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "2419200", // 28 days
      },
      // Cast to BodyInit — Uint8Array is a valid fetch body on Workers.
      body: body as unknown as BodyInit,
    });

    // 404/410 = subscription is dead → caller should prune.
    const gone = res.status === 404 || res.status === 410;
    const ok = res.status >= 200 && res.status < 300;
    return {
      endpoint: sub.endpoint,
      ok,
      status: res.status,
      gone,
      error: ok ? undefined : `push service responded ${res.status}`,
    };
  } catch (e) {
    return {
      endpoint: sub.endpoint,
      ok: false,
      status: 0,
      gone: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
