// ---------------------------------------------------------------------------
// do-qr-public.test.mjs — structural pins for the public QR dispatch/deliver
// flow (routes/public-do-qr.ts + the authed qr-token endpoints).
//
// Same source-text style as the other security regression tests
// (security-public-endpoints / security-route-coverage): the point is that
// loosening any of these properties — unknown-token 404, forward-only
// transitions, cascade reuse, authed token minting, minimal data exposure —
// trips CI and forces a human to justify the change in review.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePublicEndpoints } from "./_security-helpers.mjs";

const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), "utf8");

const publicRoute = read("src/api/routes/public-do-qr.ts");
const doRoute =
  read("src/api/routes/delivery-orders.ts") +
  read("src/api/routes/delivery-orders/_helpers.ts");
const plRoute = read("src/api/routes/packing-lists.ts");
const workerSrc = read("src/api/worker.ts");
const tokenLib = read("src/api/lib/do-qr-token.ts");

// ---------------------------------------------------------------------------
// (a) Public advance endpoint: refuses unknown tokens + non-forward actions.
// ---------------------------------------------------------------------------

test("public route rejects malformed tokens before touching the DB", () => {
  // 64-hex anchor regex must exist…
  assert.match(
    publicRoute,
    /TOKEN_RE\s*=\s*\/\^\[0-9a-f\]\{64\}\$\/i/,
    "TOKEN_RE must pin tokens to exactly 64 hex chars",
  );
  // …and gate BOTH the GET and the POST handlers.
  const gateCount = (publicRoute.match(/if\s*\(!TOKEN_RE\.test\(token\)\)\s*return\s+unknownToken\(c\)/g) ?? []).length;
  assert.ok(
    gateCount >= 2,
    `expected the TOKEN_RE guard in both GET and POST handlers (found ${gateCount})`,
  );
});

test("unknown tokens get a 404 JSON, not a stack trace", () => {
  assert.match(
    publicRoute,
    /unknownToken[\s\S]{0,400}?404/,
    "unknownToken helper must return HTTP 404",
  );
  assert.match(
    publicRoute,
    /if\s*\(!resolved\)\s*return\s+unknownToken\(c\)/,
    "a token that resolves to neither table must 404",
  );
});

test("advance refuses anything but DISPATCH / DELIVER with a 400", () => {
  assert.match(
    publicRoute,
    /body\.action\s*===\s*"DISPATCH"\s*\|\|\s*body\.action\s*===\s*"DELIVER"/,
    "action must be validated against the two allowed verbs",
  );
  assert.match(
    publicRoute,
    /action must be "DISPATCH" or "DELIVER"[\s\S]{0,80}?400/,
    "invalid actions must be rejected with HTTP 400",
  );
});

test("transitions are forward-only (no reversals reachable from the QR)", () => {
  // The step table may only ever target LOADED / DELIVERED…
  const toTargets = [...publicRoute.matchAll(/to:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    [...new Set(toTargets)].sort(),
    ["DELIVERED", "LOADED"],
    "STEP table must only target LOADED (dispatch) and DELIVERED (deliver)",
  );
  // …and never expose the office's LOADED → DRAFT reversal.
  assert.ok(
    !/to:\s*"DRAFT"/.test(publicRoute),
    "the public flow must never transition anything back to DRAFT",
  );
  // DISPATCH only from DRAFT; DELIVER only from LOADED / IN_TRANSIT.
  assert.match(publicRoute, /DISPATCH:\s*\{\s*from:\s*\["DRAFT"\]/);
  assert.match(publicRoute, /DELIVER:\s*\{\s*from:\s*\["LOADED",\s*"IN_TRANSIT"\]/);
});

test("re-scans are idempotent: already-past statuses are SKIPPED not errored", () => {
  assert.match(
    publicRoute,
    /past:\s*\["LOADED",\s*"IN_TRANSIT",\s*"DELIVERED",\s*"INVOICED"\]/,
    "DISPATCH must treat every post-DRAFT status as already done",
  );
  assert.match(
    publicRoute,
    /past:\s*\["DELIVERED",\s*"INVOICED"\]/,
    "DELIVER must treat DELIVERED/INVOICED as already done",
  );
  assert.match(publicRoute, /outcome:\s*"SKIPPED"/);
});

// ---------------------------------------------------------------------------
// (b) Cascade reuse — the career-critical pin. The public route must invoke
// the EXACT office transition + notice functions and carry no write path of
// its own.
// ---------------------------------------------------------------------------

test("public advance reuses the office PUT core + notice core (no second write path)", () => {
  assert.match(
    publicRoute,
    /import\s*\{[\s\S]*?applyDeliveryOrderUpdate[\s\S]*?\}\s*from\s*["']\.\/delivery-orders["']/,
    "must import applyDeliveryOrderUpdate from routes/delivery-orders",
  );
  assert.match(
    publicRoute,
    /import\s*\{[\s\S]*?queueDoCustomerNotice[\s\S]*?\}\s*from\s*["']\.\/delivery-orders["']/,
    "must import queueDoCustomerNotice from routes/delivery-orders",
  );
  assert.match(publicRoute, /applyDeliveryOrderUpdate\(c,\s*d\.id,/);
  assert.match(publicRoute, /queueDoCustomerNotice\(c,\s*d\.id,/);
  // No UPDATE/INSERT/DELETE statements of its own — reads only.
  assert.ok(
    !/\b(UPDATE|INSERT|DELETE)\b/.test(publicRoute.replace(/\/\/[^\n]*/g, "")),
    "public-do-qr.ts must not carry its own mutation SQL — all writes go through applyDeliveryOrderUpdate",
  );
});

test("the office PUT route still delegates to the same shared core", () => {
  // The extraction must not leave the office path on a diverging copy.
  assert.match(
    doRoute,
    /export\s+async\s+function\s+applyDeliveryOrderUpdate\(/,
    "applyDeliveryOrderUpdate must be exported from delivery-orders.ts",
  );
  assert.match(
    doRoute,
    /app\.put\("\/:id",[\s\S]{0,800}?return\s+applyDeliveryOrderUpdate\(c,\s*id,\s*body\)/,
    "PUT /:id must call the shared core",
  );
  assert.match(
    doRoute,
    /export\s+async\s+function\s+queueDoCustomerNotice\(/,
    "queueDoCustomerNotice must be exported from delivery-orders.ts",
  );
  assert.match(
    doRoute,
    /app\.post\("\/:id\/notify-customer",[\s\S]{0,800}?return\s+queueDoCustomerNotice\(c,\s*id,\s*body\)/,
    "POST /:id/notify-customer must call the shared core",
  );
});

// ---------------------------------------------------------------------------
// (b2) Token endpoints require auth (RBAC-gated, never public).
// ---------------------------------------------------------------------------

function routeBlock(src, registration) {
  const at = src.indexOf(registration);
  assert.ok(at >= 0, `route ${registration} not found`);
  return src.slice(at, at + 1200);
}

test("DO qr-token endpoint is RBAC-gated", () => {
  const block = routeBlock(doRoute, 'app.get("/:id/qr-token"');
  assert.match(
    block,
    /requirePermission\(c,\s*"delivery-orders",\s*"read"\)/,
    "GET /api/delivery-orders/:id/qr-token must gate on delivery-orders:read",
  );
  assert.match(block, /if\s*\(denied\)\s*return\s+denied/);
});

test("PL qr-token endpoint is RBAC-gated + org-scoped", () => {
  const block = routeBlock(plRoute, 'app.get("/:id/qr-token"');
  assert.match(
    block,
    /requirePermission\(c,\s*"delivery-orders",\s*"read"\)/,
    "GET /api/packing-lists/:id/qr-token must gate on delivery-orders:read",
  );
  assert.match(block, /if\s*\(denied\)\s*return\s+denied/);
  assert.match(block, /org_id\s*=\s*\?/, "PL lookup must stay org-scoped");
});

test("only the read-only public prefix bypasses auth — token minting does not", () => {
  const { prefixes } = parsePublicEndpoints();
  assert.ok(
    prefixes.includes("/api/public/do-qr/"),
    "/api/public/do-qr/ must be a registered public prefix",
  );
  assert.ok(
    !prefixes.some((p) => p.startsWith("/api/delivery-orders")),
    "delivery-orders endpoints must never be public",
  );
  assert.ok(
    !prefixes.some((p) => p.startsWith("/api/packing-lists")),
    "packing-lists endpoints must never be public",
  );
  // …and the public subapp is actually mounted.
  assert.match(workerSrc, /app\.route\("\/api\/public\/do-qr",\s*publicDoQr\)/);
});

test("public route never mints tokens — minting stays behind auth", () => {
  assert.ok(
    !publicRoute.includes("getOrCreateQrToken"),
    "public-do-qr.ts must only RESOLVE tokens; minting lives on the authed /:id/qr-token endpoints",
  );
  assert.match(doRoute, /getOrCreateQrToken\(c\.var\.DB,\s*"delivery_orders",\s*id\)/);
  assert.match(plRoute, /getOrCreateQrToken\(c\.var\.DB,\s*"packing_lists",\s*id\)/);
});

// ---------------------------------------------------------------------------
// (c) Minimal data exposure — the public payload carries no prices, no
// addresses, no contact details.
// ---------------------------------------------------------------------------

test("public payload exposes no prices / addresses / contacts", () => {
  const stripped = publicRoute.replace(/\/\/[^\n]*/g, "");
  for (const banned of [
    "valueSen",
    "totalSen",
    "unitPriceSen",
    "deliveryCostSen",
    "revenueSen",
    "deliveryAddress",
    "contactPhone",
    "contactPerson",
    "driverPhone",
  ]) {
    assert.ok(
      !stripped.includes(banned),
      `public-do-qr.ts must not read/expose ${banned}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (d) Schema contract: lowercase qrtoken column, migration + runtime ensure
// stay in lockstep.
// ---------------------------------------------------------------------------

test("qrtoken column is all-lowercase in migration 0167 and the runtime ensure", () => {
  const mig = read("migrations-postgres/0167_do_pl_qrtokens.sql");
  for (const src of [mig, tokenLib]) {
    assert.ok(
      src.includes(
        "ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS qrtoken TEXT",
      ),
      "delivery_orders.qrtoken ALTER missing",
    );
    assert.ok(
      src.includes(
        "ALTER TABLE packing_lists ADD COLUMN IF NOT EXISTS qrtoken TEXT",
      ),
      "packing_lists.qrtoken ALTER missing",
    );
  }
  // No camelCase variant anywhere in the QR plumbing (would silently fold).
  for (const [name, src] of [
    ["do-qr-token.ts", tokenLib],
    ["public-do-qr.ts", publicRoute],
    ["0167 migration", mig],
  ]) {
    assert.ok(
      !/qrToken/.test(src.replace(/\/\/[^\n]*/g, "").replace(/--[^\n]*/g, "")),
      `${name} must use the folded-lowercase qrtoken column name only`,
    );
  }
});

test("tokens are unguessable (two UUIDs, 64 hex chars)", () => {
  assert.match(
    tokenLib,
    /crypto\.randomUUID\(\)\s*\+\s*crypto\.randomUUID\(\)/,
    "newQrToken must concatenate two UUIDs",
  );
  assert.match(tokenLib, /\.replace\(\/-\/g,\s*""\)/);
});
