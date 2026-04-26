// ---------------------------------------------------------------------------
// security-route-coverage.test.mjs — verify that the route handlers we have
// already gated with requirePermission(...) STAY gated.
//
// The check is intentionally regex-based on the route source rather than a
// runtime sweep of the Hono app: it catches "agent forgot to add
// requirePermission" or "agent removed it during a refactor" PRs at the
// commit level, before the app is even rebuilt.
//
// Call shape (from src/api/lib/rbac.ts):
//   const denied = await requirePermission(c, "sales-orders", "create");
//   if (denied) return denied;
// Tests grep for that exact (resource, action) pair in the route file's
// source. Adding new gates is a one-line addition to the `routes` table
// below — that one-line addition IS the audit trail.
//
// Closes audit P1 follow-up "安全回归清单".
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import {
  readRouteSource,
  hasPermissionGate,
} from "./_security-helpers.mjs";

// ---------------------------------------------------------------------------
// Route × required (resource, action) gates. The list reflects which routes
// currently DO have requirePermission. As more gates land per the P3.3
// rollout, append rows here so the lock-in compounds.
// ---------------------------------------------------------------------------
const routes = [
  {
    file: "src/api/routes-d1/sales-orders.ts",
    required: [
      ["sales-orders", "create"],
      ["sales-orders", "confirm"],
    ],
  },
  {
    file: "src/api/routes-d1/payments.ts",
    required: [["payments", "create"]],
  },
  {
    file: "src/api/routes-d1/delivery-orders.ts",
    required: [
      ["delivery-orders", "read"],
      ["delivery-orders", "create"],
      ["delivery-orders", "update"],
      ["delivery-orders", "delete"],
    ],
  },
];

for (const r of routes) {
  test(`${r.file} mutation handlers all have requirePermission`, () => {
    const src = readRouteSource(r.file);
    for (const [resource, action] of r.required) {
      assert.ok(
        hasPermissionGate(src, resource, action),
        `${r.file} missing requirePermission(c, "${resource}", "${action}") — RBAC gate dropped`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Each gated route must also actually import requirePermission from the
// rbac module — defends against an agent commenting out the import while
// leaving the call dangling (would compile-fail in TS but pass a coarse grep).
// ---------------------------------------------------------------------------
test("every gated route imports requirePermission from ../lib/rbac", () => {
  for (const r of routes) {
    const src = readRouteSource(r.file);
    assert.match(
      src,
      /import\s*\{[^}]*\brequirePermission\b[^}]*\}\s*from\s*["']\.\.\/lib\/rbac["']/,
      `${r.file} must import requirePermission from "../lib/rbac"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Sanity: every gated handler also early-returns the `denied` response.
// Pattern: `const denied = await requirePermission(...)` followed by
// `if (denied) return denied;` somewhere in the same file.
// ---------------------------------------------------------------------------
test("every gated route early-returns the denial response", () => {
  for (const r of routes) {
    const src = readRouteSource(r.file);
    const callMatches = src.match(
      /const\s+denied\s*=\s*await\s+requirePermission\s*\(/g,
    );
    const guardMatches = src.match(/if\s*\(\s*denied\s*\)\s*return\s+denied\s*;/g);
    assert.ok(
      callMatches && callMatches.length > 0,
      `${r.file} should call requirePermission and bind to \`denied\``,
    );
    assert.ok(
      guardMatches && guardMatches.length >= callMatches.length,
      `${r.file}: ${callMatches.length} requirePermission call(s) but only ${
        guardMatches?.length ?? 0
      } \`if (denied) return denied;\` guard(s) — every gate must short-circuit`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tripwire: a hardcoded "do not regress" floor. If this number ever shrinks,
// someone removed a gate — fail loudly. (Increase the floor when adding new
// gates and update both this number and the per-route `required` table above.)
// ---------------------------------------------------------------------------
test("total requirePermission call count across gated routes does not regress", () => {
  let total = 0;
  for (const r of routes) {
    const src = readRouteSource(r.file);
    const matches = src.match(/\brequirePermission\s*\(/g) ?? [];
    total += matches.length;
  }
  // Current floor as of 2026-04-25:
  //   sales-orders.ts:    2 (create + confirm)
  //   payments.ts:        1 (create)
  //   delivery-orders.ts: 6 (list-read + stats-read + single-read + create
  //                          + update + delete)
  // Total = 9. If you add a gate, raise this number with the same PR.
  const FLOOR = 9;
  assert.ok(
    total >= FLOOR,
    `requirePermission gate count ${total} < floor ${FLOOR} — a gate was removed`,
  );
});
