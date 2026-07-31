// ---------------------------------------------------------------------------
// api-rate-limit.test.mjs — unit tests for src/api/lib/api-rate-limit.ts.
//
// Coverage:
//   1. Default ceiling (300/min) — 300 OK calls, the 301st returns 429.
//   2. Exempt paths bypass the limiter entirely.
//   3. KV missing (binding undefined) — middleware allows every request.
//   4. KV read throw — middleware allows, doesn't crash.
//   5. Different users are tracked independently in separate buckets.
//   6. Unauthenticated requests fall back to client IP.
//   7. Per-endpoint override (/api/auth/login = 10/min) is tighter than default.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type stripping handles it on Node 22+.
}

let mod;
try {
  mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/api-rate-limit.ts")).href
  );
} catch (err) {
  console.warn(
    "[api-rate-limit.test] Could not import src/api/lib/api-rate-limit.ts. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[api-rate-limit.test] Error:", err?.message ?? err);
  throw err;
}
const { apiRateLimit } = mod;

// ---- In-memory KV stub ----------------------------------------------------
//
// Models the tiny subset of the Cloudflare KV surface that the limiter uses:
// get(key) → string|null, put(key, value, opts) → void, delete(key).
// `failGet` / `failPut` flags let us simulate KV blips so we can verify the
// "fail open" posture.

function makeKv(opts = {}) {
  const store = new Map();
  return {
    store,
    failGet: opts.failGet ?? false,
    failPut: opts.failPut ?? false,
    async get(key) {
      if (this.failGet) throw new Error("KV get blip");
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value /*, opts */) {
      if (this.failPut) throw new Error("KV put blip");
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// ---- Hono Context stub ----------------------------------------------------
//
// We don't need a real Hono runtime — the middleware only touches:
//   c.req.path, c.req.header(name)
//   c.env.SESSION_CACHE
//   c.get(name) (for userId)
//   c.json(body, status) — returns a Response-shape with .status + .body
//   c.res.headers.set(name, value)
//
// next() resolves true so callers can tell whether the middleware allowed
// the request or short-circuited it.

function makeCtx({ path = "/api/customers", userId, ip = "1.2.3.4", kv, method } = {}) {
  const headers = new Map();
  if (ip) headers.set("cf-connecting-ip", ip);
  const resHeaders = new Map();
  return {
    req: {
      path,
      method,
      header(name) {
        return headers.get(name.toLowerCase()) ?? headers.get(name);
      },
    },
    // Tests assert enforcement semantics, so we explicitly enable enforce
    // mode. Production ships in warn-only by default (no API_RATE_LIMIT_MODE
    // env var → warn). Soft-launch lever per Wei Siang 2026-05-27.
    env: { SESSION_CACHE: kv, API_RATE_LIMIT_MODE: "enforce" },
    get(name) {
      if (name === "userId") return userId;
      return undefined;
    },
    res: {
      headers: {
        set(k, v) {
          resHeaders.set(k, v);
        },
        get(k) {
          return resHeaders.get(k);
        },
      },
    },
    json(body, status) {
      return { status, body, _resHeaders: resHeaders };
    },
  };
}

async function callMw(mw, ctx) {
  let nextCalled = false;
  const next = async () => {
    nextCalled = true;
  };
  const out = await mw(ctx, next);
  return { nextCalled, out };
}

// ---- Tests ----------------------------------------------------------------

test("under the limit — middleware allows and increments", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "u1", kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  assert.equal(out, undefined);
  // Counter bumped to 1 in both minute + hour buckets.
  const minuteKeys = [...kv.store.keys()].filter((k) => k.includes(":m:"));
  const hourKeys = [...kv.store.keys()].filter((k) => k.includes(":h:"));
  assert.equal(minuteKeys.length, 1);
  assert.equal(hourKeys.length, 1);
  assert.equal(kv.store.get(minuteKeys[0]), "1");
  assert.equal(kv.store.get(hourKeys[0]), "1");
});

test("default ceiling (600/min) — at cap, next request returns 429 in enforce mode", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  // Pre-populate the minute bucket to the default cap so the next
  // request is the one that should be refused. Default was bumped from
  // 300 -> 600 on 2026-05-27 to give legitimate dashboard browsing
  // more headroom while still catching abuse.
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);
  kv.store.set(`apirl:u1:m:${minuteBucket}`, "600");
  kv.store.set(`apirl:u1:h:${hourBucket}`, "600");
  const ctx = makeCtx({ userId: "u1", kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, false, "next() should NOT run when over the cap in enforce mode");
  assert.equal(out.status, 429);
  assert.equal(out.body.success, false);
  assert.match(out.body.error, /Too many requests/);
  assert.equal(out.body.retryAfterSec, 60);
  assert.equal(out._resHeaders.get("Retry-After"), "60");
});

test("warn-only mode — request over cap falls through to next() (default posture)", async () => {
  // Production default: API_RATE_LIMIT_MODE unset → warn-only. The
  // limiter still LOGS the breach but does NOT 429 the user. This is
  // the soft-launch posture per Wei Siang 2026-05-27 "不影响现在的use".
  const kv = makeKv();
  const mw = apiRateLimit();
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);
  kv.store.set(`apirl:u1:m:${minuteBucket}`, "600");
  kv.store.set(`apirl:u1:h:${hourBucket}`, "600");
  const ctx = makeCtx({ userId: "u1", kv });
  // Strip the test-default "enforce" flag to simulate prod defaults.
  ctx.env.API_RATE_LIMIT_MODE = undefined;
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, true, "next() SHOULD run in warn-only mode even past the cap");
  assert.equal(out, undefined, "no 429 response — request flows through");
});

test("exempt paths bypass limits even when over cap", async () => {
  const kv = makeKv();
  const mw = apiRateLimit({ exempt: ["/api/custom-exempt"] });
  // Pre-populate so a NON-exempt path would 429 — but exempt should sail.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  kv.store.set(`apirl:ip:1.2.3.4:m:${minuteBucket}`, "999999");

  // /api/health is in DEFAULT_EXEMPT
  const c1 = makeCtx({ path: "/api/health", kv });
  const r1 = await callMw(mw, c1);
  assert.equal(r1.nextCalled, true);
  assert.equal(r1.out, undefined);

  // /api/custom-exempt was added via opts.exempt
  const c2 = makeCtx({ path: "/api/custom-exempt", kv });
  const r2 = await callMw(mw, c2);
  assert.equal(r2.nextCalled, true);

  // /api/internal/* is exempted via the prefix rule
  const c3 = makeCtx({ path: "/api/internal/whatever", kv });
  const r3 = await callMw(mw, c3);
  assert.equal(r3.nextCalled, true);
});

test("KV missing — middleware allows every request (fail open)", async () => {
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "u1", kv: undefined });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  assert.equal(out, undefined);
});

test("KV read throws — middleware allows (fail open, doesn't crash)", async () => {
  const kv = makeKv({ failGet: true });
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "u1", kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  assert.equal(out, undefined);
});

test("KV write throws — middleware still allows the request", async () => {
  const kv = makeKv({ failPut: true });
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "u1", kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  assert.equal(out, undefined);
});

test("different users tracked independently", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  // user1 starts at the cap — should 429 (cap bumped to 600 on 2026-05-27)
  const minuteBucket = Math.floor(Date.now() / 60_000);
  kv.store.set(`apirl:user1:m:${minuteBucket}`, "600");

  const c1 = makeCtx({ userId: "user1", kv });
  const r1 = await callMw(mw, c1);
  assert.equal(r1.nextCalled, false);
  assert.equal(r1.out.status, 429);

  // user2 has no counter — should pass even though user1 is locked out.
  const c2 = makeCtx({ userId: "user2", kv });
  const r2 = await callMw(mw, c2);
  assert.equal(r2.nextCalled, true);
  assert.equal(r2.out, undefined);
});

test("unauthenticated — falls back to client IP for identity", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: undefined, ip: "9.9.9.9", kv });
  const { nextCalled } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  // Key should be IP-prefixed when there's no userId.
  const keys = [...kv.store.keys()];
  assert.ok(
    keys.some((k) => k.includes("ip:9.9.9.9")),
    `expected an IP-keyed bucket, got: ${keys.join(", ")}`,
  );
});

test("per-endpoint override — /api/auth/login tighter than default", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const minuteBucket = Math.floor(Date.now() / 60_000);
  // Login override is 10/min. Pre-populate to 10 so the next is rejected.
  kv.store.set(`apirl:ip:1.2.3.4:m:${minuteBucket}`, "10");
  const ctx = makeCtx({ path: "/api/auth/login", userId: undefined, kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, false);
  assert.equal(out.status, 429);
});

test("per-hour ceiling (10000) trips even when minute count is low", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const hourBucket = Math.floor(now / 3_600_000);
  kv.store.set(`apirl:u1:m:${minuteBucket}`, "5");
  kv.store.set(`apirl:u1:h:${hourBucket}`, "10000");
  const ctx = makeCtx({ userId: "u1", kv });
  const { nextCalled, out } = await callMw(mw, ctx);
  assert.equal(nextCalled, false);
  assert.equal(out.status, 429);
  assert.equal(out.body.retryAfterSec, 3600);
});

// ---- Authenticated-GET isolate backstop (perf audit 2026-07-31) -----------

test("authenticated GET skips the KV limiter (uses the free isolate backstop)", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "get-user-1", kv, method: "GET" });
  const { nextCalled } = await callMw(mw, ctx);
  assert.equal(nextCalled, true);
  // No KV rate-limit keys written — the ~2-round-trip KV path was bypassed.
  const keys = [...kv.store.keys()].filter((k) => k.includes(":m:") || k.includes(":h:"));
  assert.equal(keys.length, 0);
});

test("authenticated POST still goes through the KV limiter (writes stay protected)", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  const ctx = makeCtx({ userId: "post-user-1", kv, method: "POST" });
  await callMw(mw, ctx);
  assert.equal([...kv.store.keys()].filter((k) => k.includes(":m:")).length, 1);
});

test("isolate backstop still catches a runaway authenticated GET loop (enforce mode)", async () => {
  const kv = makeKv();
  const mw = apiRateLimit();
  let last;
  for (let i = 0; i < 602; i++) {
    last = await callMw(mw, makeCtx({ userId: "runaway-user", kv, method: "GET" }));
  }
  // Over the 600/10s cap → 429 in enforce mode, and STILL zero KV traffic.
  assert.equal(last.nextCalled, false);
  assert.equal([...kv.store.keys()].length, 0);
});
