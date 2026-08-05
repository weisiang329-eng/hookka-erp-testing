// ---------------------------------------------------------------------------
// me-permissions-role-source.test.mjs — the menu must read the role the same
// way the gate does.
//
// Owner 2026-08-05: "我就是 super admin 啊" — his sidebar had no Purchase
// Invoice and an empty HR group, yet every one of those pages opened fine by
// URL. Two sources of truth had drifted:
//
//   • rbac.ts (the GATE)      → users.role TEXT, short-circuits SUPER_ADMIN
//   • /me/permissions (MENU)  → users.roleId → roles.name JOIN
//
// His row carries role='SUPER_ADMIN' with a roleId the roles table doesn't
// resolve, so the JOIN produced NULL, the handler fell back to READ_ONLY, and
// hiddenNavPrefixes cut the menu down to a read-only user's.
//
// The endpoint must therefore read BOTH and let the legacy TEXT stand in, and
// must treat ADMIN like SUPER_ADMIN (rbac.ts grants both "*:*").
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(process.cwd(), "src/api/routes/auth.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

test("the role query selects the legacy users.role text, not just the join", () => {
  assert.match(SRC, /u\.role AS "legacyRole"/);
});

test("the join result may be null — the legacy text stands in before READ_ONLY", () => {
  assert.match(SRC, /roleRow\.roleName \?\? roleRow\.legacyRole \?\? null/);
});

test("ADMIN bypasses alongside SUPER_ADMIN, as the gate does", () => {
  assert.match(SRC, /resolvedRole === "SUPER_ADMIN" \|\| resolvedRole === "ADMIN"/);
});

test("a bypassing role hides nothing", () => {
  const block = SRC.slice(SRC.indexOf('resolvedRole === "SUPER_ADMIN"'));
  const head = block.slice(0, 400);
  assert.match(head, /permissions: \["\*"\]/);
  assert.match(head, /navHidden: \[\]/);
});

test("the READ_ONLY fallback is the LAST resort, not the first", () => {
  const roleNameLine = /const roleName = resolvedRole \?\? "READ_ONLY";/;
  assert.match(SRC, roleNameLine);
  // …and it must sit AFTER the bypass, or a super admin never reaches it.
  assert.ok(
    SRC.indexOf('resolvedRole === "SUPER_ADMIN"') < SRC.search(roleNameLine),
    "the bypass must be checked before the fallback",
  );
});
