// GET /api/audit-events — access control (BUG-2026-08-13-070)
//
// The handler's own header has always described a piggyback rule — "if you can
// read the resource, you can read its audit trail" — and no code implemented
// it. Any authenticated session could read the before/after snapshots of any
// record, including user rows, across all four companies (HOOKKA / OHANA /
// HOUZS / HKMFG). The org_id column existed the whole time and was never
// filtered on.
//
// These are SOURCE guards rather than a live request: the handler needs a Hono
// context, a D1 binding and a session, and the thing worth pinning is that the
// two lines never quietly disappear again. A behavioural test that mounted the
// route would pass just as well with the permission check deleted, because the
// fixture would grant everything.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/audit-events.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

// Strip comments so a guard can never be satisfied by prose that merely
// mentions requirePermission — which is exactly how this bug survived: the
// header described a permission model the code did not have.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the audit trail is gated on the resource's own read permission", () => {
  assert.match(
    CODE,
    /requirePermission\(\s*c\s*,\s*resource\s*,\s*["']read["']\s*\)/,
    "GET /api/audit-events must call requirePermission(c, resource, 'read') — " +
      "the header has claimed this piggyback rule since the file was written",
  );
  assert.match(
    CODE,
    /const\s+denied\s*=\s*await\s+requirePermission[\s\S]{0,80}?if\s*\(\s*denied\s*\)\s*return\s+denied/,
    "the denial must actually short-circuit — computing it and ignoring it is the same hole",
  );
});

test("the query is scoped to the caller's org", () => {
  assert.match(
    CODE,
    /orgId\s*=\s*\?\s*OR\s+orgId\s+IS\s+NULL/i,
    "audit_events.org_id must be filtered — prod runs four companies and the " +
      "trail crossed all of them",
  );
  assert.match(
    CODE,
    /getOrgId\(\s*c\s*\)/,
    "the org must come from the request context, never from a query param",
  );
});

test("NULL org rows stay visible — they are real history, not another tenant's", () => {
  // Rows written before org_id was populated carry NULL. Excluding them would
  // silently shorten the audit trail, which is a worse failure than the one
  // being fixed: an audit log that quietly omits events cannot be trusted at
  // all, whereas a slightly over-broad one is merely imprecise.
  assert.match(CODE, /orgId\s+IS\s+NULL/i);
});

test("the permission is checked BEFORE the query runs", () => {
  const permAt = CODE.search(/requirePermission/);
  const sqlAt = CODE.search(/FROM\s+audit_events/i);
  assert.ok(permAt > -1 && sqlAt > -1, "both the check and the query must exist");
  assert.ok(
    permAt < sqlAt,
    "checking after reading would still expose the rows to anyone who can see timing or errors",
  );
});
