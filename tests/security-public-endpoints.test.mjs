// ---------------------------------------------------------------------------
// security-public-endpoints.test.mjs — snapshot test of which API endpoints
// bypass the global Bearer-token gate in src/api/lib/auth-middleware.ts.
//
// The whole point: any new public endpoint must explicitly update this test.
// That makes accidental exposure (e.g. a route copy-paste that lands a write
// path under /api/worker/...) impossible to ship in silence — CI fails until
// the allowlist is updated, which forces a human review of why a new path
// became public.
//
// PUBLIC_PATHS (exact match) and PUBLIC_PREFIXES (prefix match) are private
// to the middleware module — we parse them out of the source text via
// _security-helpers.mjs so we don't have to widen the export surface.
//
// Closes audit P1 follow-up "安全回归清单".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicEndpoints } from "./_security-helpers.mjs";

// Snapshot contract — these two arrays must mirror PUBLIC_PATHS and
// PUBLIC_PREFIXES in src/api/lib/auth-middleware.ts EXACTLY. Any drift is
// a deliberate signal: either the change is intentional (a maintainer adds
// a new entry here in the same commit that adds it to the middleware) or
// someone widened the public surface by accident (CI fails, revert).
//
// THE WHOLE POINT of this snapshot test is that adding a new public
// endpoint trips the test, which forces the maintainer to come here and
// justify — in code review — why a new path bypasses the Bearer-token gate.
// Do NOT loosen this to "contains" or "subset" semantics — equality is the
// security control. Each entry is listed explicitly for the same reason.
const EXPECTED_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/accept-invite",
  // Phase C.6 — TOTP step-2 of password login (no bearer yet).
  "/api/auth/totp/login-verify",
  "/api/health",
];

const EXPECTED_PREFIXES = [
  "/api/worker-auth/",
  "/api/worker/",
  "/api/auth/invite/",
  // Phase B.3 — Google Workspace OAuth handshake (/start + /callback).
  "/api/auth/oauth/",
];

test("public endpoint allowlist (exact paths) is locked in", () => {
  const { paths } = parsePublicEndpoints();
  assert.deepStrictEqual(
    [...paths].sort(),
    [...EXPECTED_PATHS].sort(),
    "PUBLIC_PATHS in src/api/lib/auth-middleware.ts changed — if intentional, update EXPECTED_PATHS in this file too.",
  );
});

test("public endpoint allowlist (prefix matches) is locked in", () => {
  const { prefixes } = parsePublicEndpoints();
  assert.deepStrictEqual(
    [...prefixes].sort(),
    [...EXPECTED_PREFIXES].sort(),
    "PUBLIC_PREFIXES in src/api/lib/auth-middleware.ts changed — if intentional, update EXPECTED_PREFIXES in this file too.",
  );
});

test("login + health are still in the public exact-path list", () => {
  // Defense in depth — even if someone rewrites the snapshot wholesale,
  // the smoke-level assertion that login/health are public must hold or
  // the dashboard would 401 every user before they can authenticate.
  const { paths } = parsePublicEndpoints();
  assert.ok(
    paths.includes("/api/auth/login"),
    "/api/auth/login must remain public — without it, no user can ever sign in",
  );
  assert.ok(
    paths.includes("/api/health"),
    "/api/health must remain public — uptime probes have no Bearer token",
  );
});

test("worker portal prefix is still public (shop-floor PIN flow)", () => {
  // The Worker Portal has its own PIN+token auth via /api/worker-auth and
  // /api/worker. If someone removes these prefixes the shop floor goes dark.
  const { prefixes } = parsePublicEndpoints();
  assert.ok(prefixes.includes("/api/worker-auth/"));
  assert.ok(prefixes.includes("/api/worker/"));
});

test("invite preflight prefix is still public", () => {
  // Anyone who has the invite token URL needs to be able to GET the metadata
  // without a Bearer token — they don't have one yet.
  const { prefixes } = parsePublicEndpoints();
  assert.ok(prefixes.includes("/api/auth/invite/"));
});

test("no obviously dangerous prefix accidentally public", () => {
  // Tripwire: if any of these resource prefixes appear in PUBLIC_PREFIXES,
  // sensitive write surface is exposed. Hard-fail the build.
  const { prefixes, paths } = parsePublicEndpoints();
  const dangerous = [
    "/api/users",
    "/api/invoices",
    "/api/payments",
    "/api/sales-orders",
    "/api/purchase-orders",
    "/api/audit-events",
    "/api/admin",
  ];
  for (const d of dangerous) {
    for (const pfx of prefixes) {
      assert.ok(
        !pfx.startsWith(d),
        `dangerous prefix ${pfx} would expose ${d} to unauthenticated calls`,
      );
    }
    for (const p of paths) {
      assert.ok(
        !p.startsWith(d),
        `dangerous path ${p} would expose ${d} to unauthenticated calls`,
      );
    }
  }
});
