// ---------------------------------------------------------------------------
// so-missing-original-visibility
//
// Owner 2026-08-21: 「我的view PO 还是没有的？OCR 进来的单在SO 要可以看到顾客的
// PO的 view original的 为什么还没解决呢」
//
// The honest answer is that it HAD worked, and the break has a timestamp:
//
//   2026-07-16 → 2026-08-04   the operator (OFFICE, Siti) attached the scan on
//                             every order — 149 of 188 orders carry one
//   2026-08-05 09:33          role-policy.ts moves department roles from the
//                             permission TABLE into code; `files` is not in
//                             ALL_RESOURCES, so allExcept() cannot grant it
//   2026-08-05 → 2026-08-21   0 of 212 orders carry one
//
// The permission is fixed (BUG-2026-08-21-159, #356). What is NOT fixed by
// that is the reason it ran for two and a half weeks: a missing attachment is
// invisible. The order looks complete, the button is simply absent, and nobody
// opens an order they are not already working on.
//
// So two things are pinned here, both about being able to SEE:
//   1. a fleet-level list of orders with no original — the re-scan worklist
//   2. a way to ask the RUNNING BUILD what a role can do, since four fixes
//      were shipped against the client before anyone could check the server
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { permissionsForRole } from '../src/api/lib/role-policy.ts';

const SO = readFileSync('src/api/routes/sales-orders.ts', 'utf8');
const AUTH = readFileSync('src/api/routes/auth.ts', 'utf8');

// --- the re-scan worklist ------------------------------------------------
test('/missing-original is registered BEFORE /:id', () => {
  // Hono matches in registration order: behind /:id this endpoint becomes a
  // lookup for an order literally called "missing-original", and answers 404
  // forever. The file already carries this hazard for four other routes.
  const mine = SO.indexOf('app.get("/missing-original"');
  const byId = SO.indexOf('app.get("/:id"');
  assert.ok(mine > 0, 'the endpoint must exist');
  assert.ok(byId > 0, 'the /:id route must exist for this test to mean anything');
  assert.ok(mine < byId, `/missing-original (${mine}) must be registered before /:id (${byId})`);
});

test('it asks for the ABSENCE of an SO attachment, on this org', () => {
  const block = SO.slice(
    SO.indexOf('app.get("/missing-original"'),
    SO.indexOf('app.get("/late-to-customer"'),
  );
  assert.ok(block.length > 200, 'the handler body must be found');
  assert.match(block, /LEFT JOIN file_assets fa/);
  assert.match(block, /fa\.resourceType = 'SO'/, "resourceType 'SO' is what the upload writes");
  assert.match(block, /fa\.id IS NULL/, 'the point of the query is the rows with NO file');
  assert.match(block, /so\.orgId = \? OR so\.orgId IS NULL/, 'must stay org-scoped');
  assert.match(block, /fa\.orgId = \?/, 'the joined side needs the org filter too');
});

test('it carries what a human needs to re-scan, not just a count', () => {
  // Scan-queue bytes are NULLed on consume, so nothing here is recoverable by
  // the system. The output is a worklist for a person: which customer, which
  // PO number, when.
  const block = SO.slice(
    SO.indexOf('app.get("/missing-original"'),
    SO.indexOf('app.get("/late-to-customer"'),
  );
  for (const field of ['reference', 'customerPOId', 'customerName', 'createdAt']) {
    assert.match(block, new RegExp(`so\\.${field}\\s+AS ${field}`), `must return ${field}`);
  }
  assert.match(block, /byDay/, 'a per-day count is what makes a regression edge visible');
});

test('a malformed ?since is refused, not silently ignored', () => {
  const block = SO.slice(
    SO.indexOf('app.get("/missing-original"'),
    SO.indexOf('app.get("/late-to-customer"'),
  );
  assert.match(block, /since must be YYYY-MM-DD/);
  assert.match(block, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
});

test('it is read-only and gated on reading sales orders', () => {
  const block = SO.slice(
    SO.indexOf('app.get("/missing-original"'),
    SO.indexOf('app.get("/late-to-customer"'),
  );
  assert.match(block, /requirePermission\(c, "sales-orders", "read"\)/);
  assert.equal(
    /INSERT|UPDATE |DELETE /.test(block),
    false,
    'a diagnostic must not write',
  );
});

// --- asking the running build --------------------------------------------
test('a role’s permissions can be read back from the deployed worker', () => {
  assert.match(AUTH, /app\.get\("\/role-permissions\/:role"/);
  const block = AUTH.slice(
    AUTH.indexOf('app.get("/role-permissions/:role"'),
    AUTH.indexOf('app.get("/invite/:token"'),
  );
  assert.match(block, /requirePermission\(c, "users", "read"\)/, 'gated');
  assert.match(block, /permissionsForRole\(role\)/, 'must answer from the SAME resolver the gate uses');
  assert.match(
    block,
    /codedPolicy: false/,
    'a role with no coded policy must say so rather than look like a role with no permissions',
  );
});

test('the probe would have caught the bug it exists for', () => {
  // The property the endpoint reports. If `files` ever leaves ALL_RESOURCES
  // again, this is the assertion that fails first — and now the same fact is
  // checkable against production instead of only against the source.
  const office = permissionsForRole('OFFICE');
  assert.ok(office, 'OFFICE must have a coded policy');
  assert.ok(
    office.has('files:create') || office.has('files:*') || office.has('*:*'),
    'OFFICE scans the customer POs — without files:create the original is lost silently',
  );
});
