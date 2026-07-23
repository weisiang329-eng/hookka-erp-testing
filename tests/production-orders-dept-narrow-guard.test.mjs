// ---------------------------------------------------------------------------
// production-orders-dept-narrow-guard.test.mjs — lock test for the
// "dept page must return non-active dept JCs" invariant.
//
// Bug history:
//   2026-05-11 09:23 — commit f5657f5 added `AND departmentCode = ?` to the
//     outer JC SELECT in fetchFilteredPOs (file: src/api/routes/
//     production-orders.ts). Every dept page (Fab Sew / Foam / Framing /
//     Webbing / Upholstery / Packing) blanked out every non-active dept's
//     date cell: the frontend picker at production/index.tsx ~L1914 does
//     a strict wipKey match against same-PO JCs of OTHER depts, and those
//     JCs were no longer in the response.
//   2026-05-11 10:43 — commit d559729 reverted the outer narrow.
//
// Same lesson was already commented at production-orders.ts ~L948-960 from
// an earlier attempt, but the comment did not prevent re-introduction.
// This test makes the next attempt FAIL CI — pin the SQL shape so the bad
// narrow can't sneak in via a "perf optimization" PR.
//
// Source-level structural test (no DB / no worker runtime), matching the
// pattern of production-wip-producer-output.test.mjs.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `fetchFilteredPOs` (which holds the jcWhereDept template + the warning
// comment below) moved from production-orders.ts to
// production-orders/_helpers.ts in the 2026-07-23 helper-extraction refactor.
// Read BOTH files so this guard keeps finding the invariant wherever the code
// lives — the lock is on the SQL shape, not on which file it sits in.
const SRC_FILES = [
  'src/api/routes/production-orders.ts',
  'src/api/routes/production-orders/_helpers.ts',
];

function read() {
  return SRC_FILES
    .map((f) => readFileSync(resolve(process.cwd(), f), 'utf8'))
    .join('\n\n');
}

function extractJcWhereDept(src) {
  // Match the template literal that builds the outer JC SELECT's WHERE.
  // Spans multiple lines, ends at the closing backtick before `: "";`.
  const m = src.match(/const jcWhereDept = deptFilter\s*\?\s*`[\s\S]*?`\s*:\s*"";/);
  return m ? m[0] : null;
}

test('jcWhereDept SQL template exists in fetchFilteredPOs', () => {
  const src = read();
  const sql = extractJcWhereDept(src);
  assert.ok(
    sql,
    'Could not locate `const jcWhereDept = deptFilter ? \\` WHERE ... \\` : "";` ' +
      'in production-orders.ts. If the template was renamed or restructured, ' +
      'update this test to match — but make sure the invariants below still hold.',
  );
});

test('outer JC WHERE must NOT narrow by departmentCode (lock against f5657f5 regression)', () => {
  const src = read();
  const sql = extractJcWhereDept(src);
  assert.ok(sql, 'jcWhereDept template missing — see previous test');

  // Isolate the OUTER WHERE only — everything up to the first `IN (` that
  // opens the productionOrderId subquery. The inner subquery is allowed
  // (and required) to filter by departmentCode; we only care about the
  // top-level SELECT's WHERE here.
  const outerEnd = sql.indexOf('IN (');
  assert.ok(outerEnd > 0, 'Could not locate end of outer WHERE clause');
  const outerWhere = sql.slice(0, outerEnd);

  // Outer WHERE must NOT contain `departmentCode`. The valid shape is
  // `WHERE orgId = ? AND productionOrderId IN (...)`.
  assert.doesNotMatch(
    outerWhere,
    /departmentCode/i,
    [
      'OUTER JC WHERE clause must not reference departmentCode.',
      '',
      'See src/api/routes/production-orders.ts comments at ~L982-994:',
      'narrowing the outer SELECT by departmentCode blanks every non-active',
      'dept cell on every dept page (the frontend picker at production/',
      'index.tsx ~L1914 does a strict wipKey match against same-PO JCs of',
      'OTHER depts to populate columns like Fab Sew / Foam / Framing /',
      'Webbing on the Upholstery tab).',
      '',
      '2026-05-11 commit f5657f5 introduced this regression; reverted in',
      'commit d559729 the same day. Do not re-introduce.',
      '',
      'Outer WHERE captured:',
      outerWhere,
    ].join('\n'),
  );
});

test('inner PO-id subquery DOES still narrow by departmentCode (positive lock for perf win)', () => {
  const src = read();
  const sql = extractJcWhereDept(src);
  assert.ok(sql, 'jcWhereDept template missing — see first test');

  // The inner `po.id IN (SELECT productionOrderId FROM <jcSource> WHERE
  // orgId = ? AND departmentCode = ?)` subquery is the perf win — it
  // restricts the PO set to those that have at least one JC of this dept.
  // If someone removes THIS filter while trying to fix something else, the
  // outer SELECT pulls JCs for every PO in the org, defeating the dept-
  // narrow's purpose. Pin it here too.
  assert.match(
    sql,
    /SELECT\s+productionOrderId\s+FROM\s+\$\{jcSource\}\s+WHERE\s+orgId\s*=\s*\?\s+AND\s+departmentCode\s*=\s*\?/i,
    'Inner PO-id subquery must still filter by departmentCode — that is the dept page perf optimization. Without it the page pulls every PO in the org.',
  );
});

test('comment block warning against re-introducing the outer narrow is present', () => {
  const src = read();
  // The defensive comment block was added in commit d559729 to warn future
  // contributors. The lock test is the real enforcement, but having the
  // comment AND the test makes the lesson harder to miss.
  assert.match(
    src,
    /attempt to add `AND departmentCode = \?` here/,
    'Warning comment about commit f5657f5 must remain — pairs with this lock test as defense-in-depth.',
  );
});
