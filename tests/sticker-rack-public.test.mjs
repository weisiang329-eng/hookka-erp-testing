// ---------------------------------------------------------------------------
// sticker-rack-public.test.mjs — structural pins for the PUBLIC packing-sticker
// → RACK assignment flow (routes/public-rack-write.ts + the authed token-mint
// endpoint on production-orders.ts + the shared applyPackingRack helper).
//
// Same source-text style as do-qr-public.test.mjs: the point is that loosening
// any of these properties — unknown-token 404, single-field scope-limited
// write, PACKING-only + rack-must-exist validation, token-from-row tenant
// safety, authed-only minting, no-PII exposure, snake_case qr_token column,
// shared-write-helper-no-drift — trips CI and forces a human to justify it in
// review.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePublicEndpoints } from "./_security-helpers.mjs";

const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), "utf8");

const publicRoute = read("src/api/routes/public-rack-write.ts");
const tokenLib = read("src/api/lib/jobcard-qr-token.ts");
const writeHelper = read("src/api/lib/packing-rack-write.ts");
const prodRoute = read("src/api/routes/production-orders.ts");
const workerRoute = read("src/api/routes/worker.ts");
const workerSrc = read("src/api/worker.ts");
const rateCfg = read("src/api/lib/api-rate-limit-config.ts");

// ---------------------------------------------------------------------------
// (a) Token validation: 64-hex anchor before any DB touch, gating BOTH handlers.
// ---------------------------------------------------------------------------

test("public route rejects malformed tokens before touching the DB", () => {
  assert.match(
    publicRoute,
    /TOKEN_RE\s*=\s*\/\^\[0-9a-f\]\{64\}\$\/i/,
    "TOKEN_RE must pin tokens to exactly 64 hex chars",
  );
  const gateCount = (
    publicRoute.match(
      /if\s*\(!TOKEN_RE\.test\(token\)\)\s*return\s+unknownToken\(c\)/g,
    ) ?? []
  ).length;
  assert.ok(
    gateCount >= 2,
    `expected the TOKEN_RE guard in both GET and POST handlers (found ${gateCount})`,
  );
});

test("unknown / non-PACKING tokens get a 404 JSON, not a stack trace", () => {
  assert.match(
    publicRoute,
    /unknownToken[\s\S]{0,400}?404/,
    "unknownToken helper must return HTTP 404",
  );
  // A token that resolves to no card 404s…
  assert.match(
    publicRoute,
    /if\s*\(!card\)\s*return\s+unknownToken\(c\)/,
    "a token that resolves to no card must 404",
  );
  // …and a token whose card isn't PACKING is treated as unknown (no leak).
  assert.match(
    publicRoute,
    /departmentCode[\s\S]{0,80}?PACKING[\s\S]{0,80}?return\s+unknownToken\(c\)/,
    "GET must 404 a non-PACKING card",
  );
});

// ---------------------------------------------------------------------------
// (b) Scope-limited write: ONLY the rack number, on the token's own card.
// ---------------------------------------------------------------------------

test("POST reads EXACTLY ONE body field (rackingNumber); no other mutation", () => {
  // Only rackingNumber is destructured off the body.
  assert.match(
    publicRoute,
    /body\.rackingNumber\s*===\s*"string"\s*\?\s*body\.rackingNumber\s*:\s*null/,
    "POST must read only the rackingNumber field off the body",
  );
  // The payload must NOT trust a client jobCardId / status / poNo etc.
  assert.ok(
    !/body\.jobCardId|body\.status|body\.poNo|body\.productionOrderId/.test(
      publicRoute,
    ),
    "the public POST must never read jobCardId/status/poNo/productionOrderId from the request",
  );
  // The card id passed to the write is the TOKEN's resolved row, never the body.
  assert.match(
    publicRoute,
    /applyPackingRack\(c\.var\.DB,\s*card\.id,\s*rackingNumber\)/,
    "the write must use the token-resolved card.id, not a request-supplied id",
  );
});

test("public route carries NO mutation SQL of its own — writes go through the shared helper", () => {
  const stripped = publicRoute.replace(/\/\/[^\n]*/g, "");
  assert.ok(
    !/\b(UPDATE|INSERT|DELETE)\b/.test(stripped),
    "public-rack-write.ts must not carry its own write SQL — set/clear goes through applyPackingRack",
  );
  assert.match(
    publicRoute,
    /import\s*\{[\s\S]*?applyPackingRack[\s\S]*?\}\s*from\s*["']\.\.\/lib\/packing-rack-write["']/,
    "must import applyPackingRack from lib/packing-rack-write",
  );
});

// ---------------------------------------------------------------------------
// (c) The shared write helper enforces PACKING-only + rack-must-exist +
//     reject-don't-normalize + empty-clears, and BOTH paths use it (no drift).
// ---------------------------------------------------------------------------

test("applyPackingRack enforces PACKING-only + catalog rack validation", () => {
  // PACKING-only.
  assert.match(
    writeHelper,
    /departmentCode\s*\|\|\s*""\)\.toUpperCase\(\)\s*!==\s*"PACKING"/,
    "helper must reject non-PACKING cards",
  );
  assert.match(
    writeHelper,
    /Rack number applies to Packing cards only\./,
    "helper must keep the PACKING-only message",
  );
  // Rack value validated against the warehouse catalog (reject, don't normalize).
  assert.match(
    writeHelper,
    /SELECT rack FROM rack_locations WHERE rack = \? LIMIT 1/,
    "helper must validate the rack against rack_locations",
  );
  assert.match(
    writeHelper,
    /is not a known warehouse location/,
    "an unknown rack must be rejected, not normalized",
  );
  // Empty string clears (rack || null).
  assert.match(
    writeHelper,
    /UPDATE job_cards SET rackingNumber = \? WHERE id = \?[\s\S]{0,120}?rack \|\| null/,
    "an empty rack must clear job_cards.rackingNumber",
  );
  // Mirrors onto the PO (same contract as the office dropdown).
  assert.match(
    writeHelper,
    /UPDATE production_orders SET rackingNumber = \?, updated_at = \? WHERE id = \?/,
    "helper must mirror the rack onto production_orders",
  );
});

test("BOTH the worker path and the public path use the shared applyPackingRack (no drift)", () => {
  assert.match(
    workerRoute,
    /import\s*\{\s*applyPackingRack\s*\}\s*from\s*["']\.\.\/lib\/packing-rack-write["']/,
    "worker.ts must import the shared helper",
  );
  assert.match(
    workerRoute,
    /app\.post\("\/packing-rack"[\s\S]{0,800}?applyPackingRack\(c\.var\.DB,/,
    "worker /packing-rack must call the shared helper",
  );
  assert.match(
    publicRoute,
    /applyPackingRack\(c\.var\.DB,\s*card\.id,/,
    "public route must call the shared helper",
  );
});

// ---------------------------------------------------------------------------
// (d) Tenant safety: the card (and its org) is resolved from the token's own
//     row, never from the request.
// ---------------------------------------------------------------------------

test("the card is resolved from the token's own job_card row", () => {
  assert.match(
    publicRoute,
    /WHERE jc\.qr_token = \?/,
    "resolveCard must look the card up by its qr_token, not by a request id",
  );
});

// ---------------------------------------------------------------------------
// (e) Minimal data exposure — no prices / customers / addresses / contacts.
// ---------------------------------------------------------------------------

test("public GET payload exposes no prices / customers / addresses / contacts", () => {
  const stripped = publicRoute.replace(/\/\/[^\n]*/g, "");
  for (const banned of [
    "valueSen",
    "totalSen",
    "unitPriceSen",
    "priceSen",
    "customerName",
    "customerId",
    "deliveryAddress",
    "contactPhone",
    "contactPerson",
  ]) {
    assert.ok(
      !stripped.includes(banned),
      `public-rack-write.ts must not read/expose ${banned}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (f) Token minting stays behind auth; the public route never mints.
// ---------------------------------------------------------------------------

test("public route never mints tokens — minting stays on the authed endpoint", () => {
  assert.ok(
    !publicRoute.includes("getOrCreateJobCardQrToken"),
    "public-rack-write.ts must only RESOLVE tokens; minting lives on the authed endpoint",
  );
  // The mint endpoint is RBAC-gated (read — same gate as 'show me the QR').
  const at = prodRoute.indexOf('app.post("/packing-rack-tokens"');
  assert.ok(at >= 0, "the authed mint endpoint must exist");
  // Window sized to span the whole endpoint (the mint now happens in a
  // batched parallel pass near the end — the per-piece serial loop was
  // replaced for performance, so the getOrCreateJobCardQrToken call sits
  // further down than it used to).
  const block = prodRoute.slice(at, at + 6500);
  assert.match(
    block,
    /requirePermission\(c,\s*"production-orders",\s*"read"\)/,
    "the mint endpoint must gate on production-orders:read",
  );
  assert.match(block, /if\s*\(denied\)\s*return\s+denied/);
  assert.match(
    block,
    /getOrCreateJobCardQrToken\(c\.var\.DB,/,
    "the mint endpoint mints via getOrCreateJobCardQrToken",
  );
  // The mint endpoint must import the helpers.
  assert.match(
    prodRoute,
    /import\s*\{[\s\S]*?getOrCreateJobCardQrToken[\s\S]*?\}\s*from\s*["']\.\.\/lib\/jobcard-qr-token["']/,
    "production-orders.ts must import the token helpers",
  );
});

// ---------------------------------------------------------------------------
// (g) Public prefix + tightened rate limit.
// ---------------------------------------------------------------------------

test("the public prefix bypasses auth and is mounted", () => {
  const { prefixes } = parsePublicEndpoints();
  assert.ok(
    prefixes.includes("/api/public/rack-write/"),
    "/api/public/rack-write/ must be a registered public prefix",
  );
  // production-orders (where minting lives) must NEVER be public.
  assert.ok(
    !prefixes.some((p) => p.startsWith("/api/production-orders")),
    "production-orders endpoints must never be public",
  );
  assert.match(
    workerSrc,
    /app\.route\("\/api\/public\/rack-write",\s*publicRackWrite\)/,
    "the public rack-write subapp must be mounted",
  );
});

test("the public rack-write surface has the tightened public rate-limit ceiling", () => {
  assert.match(
    rateCfg,
    /prefix:\s*"\/api\/public\/rack-write",\s*limits:\s*\{\s*perMinute:\s*30,\s*perHour:\s*300\s*\}/,
    "public rack-write must be limited to 30/min, 300/hr (like the other public scan surfaces)",
  );
  // The previously-missing rack-qr override is now present too.
  assert.match(
    rateCfg,
    /prefix:\s*"\/api\/public\/rack-qr",\s*limits:\s*\{\s*perMinute:\s*30,\s*perHour:\s*300\s*\}/,
    "the public rack-qr surface should also carry the tightened ceiling",
  );
});

// ---------------------------------------------------------------------------
// (h) Token shape + snake_case column hygiene.
// ---------------------------------------------------------------------------

test("tokens are unguessable (two UUIDs, 64 hex chars)", () => {
  assert.match(
    tokenLib,
    /crypto\.randomUUID\(\)\s*\+\s*crypto\.randomUUID\(\)/,
    "newJobCardQrToken must concatenate two UUIDs",
  );
  assert.match(tokenLib, /\.replace\(\/-\/g,\s*""\)/);
});

test("qr_token is snake_case in migration 0187 and the runtime ensure", () => {
  const mig = read("migrations-postgres/0187_jobcard_qr_token.sql");
  for (const src of [mig, tokenLib]) {
    assert.ok(
      src.includes(
        "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qr_token TEXT",
      ),
      "job_cards.qr_token ALTER missing (snake_case + IF NOT EXISTS)",
    );
  }
  // The runtime self-apply is what actually reaches prod (migrations are inert).
  assert.match(
    tokenLib,
    /ensureJobCardQrTokenColumn/,
    "a runtime ensure must exist (deploys don't replay migrations)",
  );
  // No camelCase qrToken anywhere in the new plumbing (would silently 400).
  for (const [name, src] of [
    ["jobcard-qr-token.ts", tokenLib],
    ["public-rack-write.ts", publicRoute],
    ["0187 migration", mig],
  ]) {
    assert.ok(
      !/qrToken/.test(src.replace(/\/\/[^\n]*/g, "").replace(/--[^\n]*/g, "")),
      `${name} must use snake_case qr_token only (no camelCase qrToken)`,
    );
  }
});

// ---------------------------------------------------------------------------
// (i) The token is never logged.
// ---------------------------------------------------------------------------

test("the token is never written to a log line", () => {
  // No console.* call interpolates the token VALUE. We look for the token
  // variable being passed/interpolated (`${token}`, `, token`, `+ token`) —
  // NOT the literal ":token]" route-path text that appears in the log message
  // (that is the endpoint label, not the secret).
  const logLines = [...publicRoute.matchAll(/console\.[a-z]+\([^)]*\)/gi)].map(
    (m) => m[0],
  );
  for (const line of logLines) {
    assert.ok(
      !/\$\{token\}|[,+]\s*token\b/.test(line),
      `a log line must not include the token value: ${line}`,
    );
  }
});
