// ---------------------------------------------------------------------------
// audit.test.mjs — unit tests for src/api/lib/audit.ts (P3.4 finish).
//
// Verifies emitAudit() writes one row to audit_events with the right
// shape, snapshots actor / IP / UA from the Hono ctx, and never throws
// when the DB write fails. Mirrors the stub pattern from authz.test.mjs.
//
// Coverage:
//   1. Module loads + exports emitAudit.
//   2. emitAudit writes one INSERT to audit_events with the right columns.
//   3. Actor (userId / role / displayName) is snapshotted from ctx.
//   4. before/after JSON is stringified; null stays null.
//   5. DB failure is swallowed — emitAudit never throws.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let loaderRegistered = false;
try {
  register('tsx/esm', pathToFileURL('./'));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it.
}

let audit;
try {
  audit = await import(
    pathToFileURL(resolve(process.cwd(), 'src/api/lib/audit.ts')).href
  );
} catch (err) {
  console.warn(
    '[audit.test] Could not import src/api/lib/audit.ts. ' +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn('[audit.test] Error:', err?.message ?? err);
  throw err;
}

// ---- Stub builder ---------------------------------------------------------
//
// Records every prepare(sql).bind(...).run() call so tests can assert that
// emitAudit issued the expected INSERT and bind values.
function makeCtx({ userId = 'u1', userRole = 'STAFF', userName = 'Alice', dbThrows = false } = {}) {
  const calls = [];

  const dbStub = {
    prepare(sql) {
      const lastBind = { values: null };
      const stmt = {
        bind(...vals) {
          lastBind.values = vals;
          return stmt;
        },
        async first() {
          // users.displayName lookup
          if (/SELECT displayName FROM users/i.test(sql)) {
            return { displayName: userName };
          }
          return null;
        },
        async run() {
          calls.push({ sql, bind: lastBind.values });
          if (dbThrows) {
            throw new Error('simulated DB failure');
          }
          return { meta: {}, success: true };
        },
      };
      return stmt;
    },
  };

  const variables = new Map([
    ['userId', userId],
    ['userRole', userRole],
  ]);

  const ctx = {
    var: { DB: dbStub },
    req: {
      header(name) {
        if (name === 'cf-connecting-ip') return '203.0.113.5';
        if (name === 'user-agent') return 'test-agent/1.0';
        return null;
      },
    },
    set(k, v) {
      variables.set(k, v);
    },
    get(k) {
      return variables.get(k);
    },
  };

  return { ctx, calls };
}

// ---- Tests ----------------------------------------------------------------

test('audit module loads + exports emitAudit', () => {
  assert.ok(audit, 'audit module should load');
  assert.equal(typeof audit.emitAudit, 'function');
});

test('emitAudit writes one INSERT into audit_events with all expected columns', async () => {
  const { ctx, calls } = makeCtx();
  await audit.emitAudit(ctx, {
    resource: 'purchase-orders',
    resourceId: 'po-abc12345',
    action: 'create',
    after: { id: 'po-abc12345', status: 'DRAFT', totalSen: 1234 },
  });

  // One run() should be the INSERT (the displayName lookup uses .first(),
  // which is not recorded in `calls`).
  const inserts = calls.filter((c) => /INSERT INTO audit_events/i.test(c.sql));
  assert.equal(inserts.length, 1, 'exactly one audit_events INSERT expected');

  const [row] = inserts;
  // Bind order from audit.ts:
  //   id, actorUserId, actorUserName, actorRole,
  //   resource, resourceId, action,
  //   beforeJson, afterJson, source, ipAddress, userAgent
  assert.match(row.bind[0], /^aud-/, 'id should be prefixed aud-');
  assert.equal(row.bind[1], 'u1', 'actorUserId from ctx');
  assert.equal(row.bind[2], 'Alice', 'actorUserName from displayName lookup');
  assert.equal(row.bind[3], 'STAFF', 'actorRole from ctx');
  assert.equal(row.bind[4], 'purchase-orders');
  assert.equal(row.bind[5], 'po-abc12345');
  assert.equal(row.bind[6], 'create');
  assert.equal(row.bind[7], null, 'before is null for create');
  assert.equal(
    row.bind[8],
    JSON.stringify({ id: 'po-abc12345', status: 'DRAFT', totalSen: 1234 }),
    'after is stringified',
  );
  assert.equal(row.bind[9], 'ui', 'source defaults to "ui"');
  assert.equal(row.bind[10], '203.0.113.5', 'ip from cf-connecting-ip');
  assert.equal(row.bind[11], 'test-agent/1.0', 'ua from user-agent header');
});

test('emitAudit stringifies both before and after for update-style events', async () => {
  const { ctx, calls } = makeCtx();
  await audit.emitAudit(ctx, {
    resource: 'invoices',
    resourceId: 'inv-9',
    action: 'void',
    before: { status: 'DRAFT' },
    after: { status: 'CANCELLED' },
  });

  const insert = calls.find((c) => /INSERT INTO audit_events/i.test(c.sql));
  assert.ok(insert, 'INSERT should have been issued');
  assert.equal(insert.bind[7], JSON.stringify({ status: 'DRAFT' }));
  assert.equal(insert.bind[8], JSON.stringify({ status: 'CANCELLED' }));
});

test('emitAudit does NOT throw when the DB INSERT fails', async () => {
  const { ctx } = makeCtx({ dbThrows: true });
  // Should resolve without throwing, even though run() throws.
  await assert.doesNotReject(
    audit.emitAudit(ctx, {
      resource: 'workers',
      resourceId: 'w-1',
      action: 'delete',
      before: { id: 'w-1', name: 'X' },
    }),
    'emitAudit must swallow DB errors so the underlying mutation completes',
  );
});
