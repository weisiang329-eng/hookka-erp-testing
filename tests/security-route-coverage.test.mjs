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
    file: "src/api/routes/sales-orders.ts",
    required: [
      ["sales-orders", "create"],
      ["sales-orders", "confirm"],
    ],
  },
  {
    file: "src/api/routes/payments.ts",
    required: [
      ["payments", "read"],
      ["payments", "create"],
      ["payments", "update"],
    ],
  },
  {
    file: "src/api/routes/delivery-orders.ts",
    required: [
      ["delivery-orders", "read"],
      ["delivery-orders", "create"],
      ["delivery-orders", "update"],
      ["delivery-orders", "delete"],
    ],
  },
  {
    file: "src/api/routes/invoices.ts",
    required: [
      ["invoices", "read"],
      ["invoices", "create"],
      ["invoices", "update"],
      ["invoices", "post"],
      ["invoices", "void"],
      ["invoices", "delete"],
    ],
  },
  {
    file: "src/api/routes/cost-ledger.ts",
    required: [["cost-ledger", "read"]],
  },
  {
    file: "src/api/routes/three-way-match.ts",
    required: [
      ["three-way-match", "read"],
      ["three-way-match", "create"],
    ],
  },
  {
    file: "src/api/routes/grn.ts",
    required: [
      ["grn", "read"],
      ["grn", "create"],
      ["grn", "update"],
    ],
  },
  {
    file: "src/api/routes/purchase-orders.ts",
    required: [
      ["purchase-orders", "read"],
      ["purchase-orders", "create"],
      ["purchase-orders", "update"],
      ["purchase-orders", "approve"],
      ["purchase-orders", "receive"],
      ["purchase-orders", "delete"],
    ],
  },
  {
    file: "src/api/routes/debit-notes.ts",
    required: [
      ["debit-notes", "read"],
      ["debit-notes", "create"],
      ["debit-notes", "update"],
    ],
  },
  {
    file: "src/api/routes/e-invoices.ts",
    required: [
      ["e-invoices", "read"],
      ["e-invoices", "create"],
      ["e-invoices", "update"],
    ],
  },
  {
    file: "src/api/routes/payroll.ts",
    required: [
      ["payroll", "read"],
      ["payroll", "create"],
      ["payroll", "update"],
    ],
  },
  {
    file: "src/api/routes/payslips.ts",
    required: [
      ["payslips", "read"],
      ["payslips", "create"],
      ["payslips", "update"],
    ],
  },
  {
    file: "src/api/routes/accounting.ts",
    required: [
      ["accounting", "read"],
      ["accounting", "create"],
      ["accounting", "update"],
      ["accounting", "delete"],
    ],
  },
  {
    file: "src/api/routes/users.ts",
    required: [
      ["users", "read"],
      ["users", "create"],
      ["users", "update"],
      ["users", "delete"],
    ],
  },
  {
    file: "src/api/routes/workers.ts",
    required: [
      ["workers", "read"],
      ["workers", "create"],
      ["workers", "update"],
      ["workers", "delete"],
    ],
  },
  {
    file: "src/api/routes/purchase-invoices.ts",
    required: [
      ["purchase-invoices", "create"],
      ["purchase-invoices", "update"],
      ["purchase-invoices", "delete"],
    ],
  },
  {
    file: "src/api/routes/credit-notes.ts",
    required: [
      ["credit-notes", "read"],
      ["credit-notes", "create"],
      ["credit-notes", "update"],
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
  // Current floor as of 2026-04-29 (Sprint 6 expansion):
  //   accounting.ts:       11
  //   cost-ledger.ts:       4
  //   credit-notes.ts:      4
  //   debit-notes.ts:       4
  //   delivery-orders.ts:   6
  //   e-invoices.ts:        4
  //   grn.ts:               4
  //   invoices.ts:          8 (read x3 + create + update + post + void + delete)
  //   payments.ts:          4
  //   payroll.ts:           3
  //   payslips.ts:          4
  //   purchase-invoices.ts: 3
  //   purchase-orders.ts:   7
  //   sales-orders.ts:      2 (create + confirm)
  //   three-way-match.ts:   2
  //   users.ts:            11
  //   workers.ts:           5
  // Total = 86. (One sales-orders read used to count via a different
  // file; rely on the live sum below — FLOOR is a tripwire, not an
  // exact match.) If you add a gate, raise this number with the same PR.
  const FLOOR = 86;
  assert.ok(
    total >= FLOOR,
    `requirePermission gate count ${total} < floor ${FLOOR} — a gate was removed`,
  );
});
