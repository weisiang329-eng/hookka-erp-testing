// ---------------------------------------------------------------------------
// tenant-orgid-fastpath.test.mjs — the per-request orgId round-trip removal
// (perf audit 2026-07-31). authMiddleware now carries orgId on the KV-cached
// session row (like role) and stashes it on ctx; tenantMiddleware reuses it and
// only falls back to the live `SELECT orgId FROM users` when it's absent. This
// removes the ONLY uncached DB round-trip that every /api/* request paid.
//
// Structural pins (the behavioural safety net is tenant-isolation.test.mjs +
// worker-auth.test.mjs, which still pass): guarantees the fast path stays wired
// and stays backward-compatible (fallback query preserved).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const auth = readFileSync(resolve(process.cwd(), "src/api/lib/auth-middleware.ts"), "utf8");
const tenant = readFileSync(resolve(process.cwd(), "src/api/lib/tenant.ts"), "utf8");

test("auth session query + cache row carry orgId", () => {
  // orgId joined into the session verify query (so it rides the KV cache)
  assert.match(auth, /u\.orgId AS orgId/);
  // and the cached-row type includes it
  assert.match(auth.replace(/\s+/g, " "), /type SessionJoinRow = \{[^}]*orgId\?: string \| null/);
  // stashed on ctx for tenantMiddleware, guarded on presence (backward-compat)
  assert.match(auth, /if \(row\.orgId\) \{[\s\S]*?\.set\(\s*"orgId",\s*row\.orgId,?\s*\)/);
});

test("tenant middleware uses the pre-resolved orgId and skips the DB round-trip", () => {
  assert.match(tenant, /c\.get[\s\S]*?\)\(\s*"orgId",?\s*\)/);
  assert.match(tenant, /if \(preresolvedOrgId\) \{\s*await next\(\);\s*return;\s*\}/);
  // the live fallback query is STILL there for old cached sessions
  assert.match(tenant, /SELECT orgId AS orgId FROM users WHERE id = \? LIMIT 1/);
});
