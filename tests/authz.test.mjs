// ---------------------------------------------------------------------------
// authz.test.mjs — unit tests for src/api/lib/authz.ts (P3.3 schema-only).
//
// Uses lightweight stubs for c.var.DB and c.env.AUTHZ_KV — no real D1 or KV
// needed. Same node:test pattern as tests/smoke.test.mjs so CI picks it up
// once package.json's `test` script globs tests/*.test.mjs (P3.3-followup).
//
// Until then, run directly: `node --test tests/authz.test.mjs`.
//
// Coverage:
//   1. SUPER_ADMIN passes any (resource, action) — even with empty matrix.
//   2. READ_ONLY passes (X, "read") for any resource, fails (X, "create").
//   3. Unknown / null role -> READ_ONLY fallback behavior.
//   4. Unauthenticated request -> 401.
//   5. Permission set is cached: two consecutive checks issue ONE D1 query.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// The module under test is TypeScript. Node 22+ can strip types natively;
// older Node (CI uses v20) cannot. Register tsx as a loader so this test
// runs cleanly on both. tsx is already an installed dev dep (used by `npm
// run api`).
let loaderRegistered = false;
try {
  register('tsx/esm', pathToFileURL('./'));
  loaderRegistered = true;
} catch {
  // Native type-stripping (Node 22.6+ with --experimental-strip-types or
  // Node 24+ unflagged) handles the .ts import without a loader. If both
  // tsx registration AND native stripping fail, the dynamic import below
  // will throw and the suite will fail loudly — that's the right behavior.
}

let authz;
try {
  authz = await import(
    pathToFileURL(resolve(process.cwd(), 'src/api/lib/authz.ts')).href
  );
} catch (err) {
  console.warn(
    '[authz.test] Could not import src/api/lib/authz.ts. ' +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn('[authz.test] Error:', err?.message ?? err);
  throw err;
}

// ---- Stub builders ---------------------------------------------------------

/**
 * Build a fake Hono Context that satisfies the AuthzCtx shape used by authz.ts.
 *
 * Options:
 *   userId        — value of c.var.userId (omit for unauthenticated).
 *   userRow       — the row returned by the users + roles join query. If null,
 *                   authz treats it as "user has no row".
 *   permissionRows — rows returned by the role_permissions JOIN query.
 *   kv             — set false to omit the KV binding entirely.
 *
 * Tracks how many times each prepared query was executed so tests can assert
 * cache-hit behavior.
 */
function makeCtx({ userId, userRow = null, permissionRows = [], kv = true } = {}) {
  const queryCounts = { user: 0, perms: 0 };
  const store = new Map(); // KV store

  const variables = new Map();
  if (userId) variables.set('userId', userId);

  const dbStub = {
    prepare(sql) {
      // Crude SQL routing — match by substring.
      const isUserLookup = /FROM users u/i.test(sql);
      const isPermLookup = /FROM role_permissions rp/i.test(sql);
      return {
        bind() {
          return {
            async first() {
              if (isUserLookup) {
                queryCounts.user += 1;
                return userRow;
              }
              return null;
            },
            async all() {
              if (isPermLookup) {
                queryCounts.perms += 1;
                return { results: permissionRows };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const kvStub = kv
    ? {
        async get(key, opts) {
          const v = store.get(key);
          if (v === undefined) return null;
          if (opts?.type === 'json') return JSON.parse(v);
          return v;
        },
        async put(key, value) {
          store.set(key, value);
        },
        async delete(key) {
          store.delete(key);
        },
      }
    : undefined;

  let lastResponse = null;

  const ctx = {
    var: {
      DB: dbStub,
      get userId() {
        return variables.get('userId');
      },
      get userRole() {
        return variables.get('userRole');
      },
    },
    env: { AUTHZ_KV: kvStub },
    executionCtx: {
      waitUntil(p) {
        // For tests, await synchronously by attaching a no-op then.
        // This keeps the cache-write completion deterministic via the
        // returned promise's resolution — tests await checks before asserting.
        // In practice the KV stub above is synchronous so the promise is
        // already settled by the time we get here.
        void p.catch(() => {});
      },
    },
    set(k, v) {
      variables.set(k, v);
    },
    get(k) {
      return variables.get(k);
    },
    json(body, status) {
      lastResponse = { body, status };
      return lastResponse;
    },
  };

  return { ctx, queryCounts, getResponse: () => lastResponse, kvStore: store };
}

// ---- Tests -----------------------------------------------------------------

test('authz module loads', () => {
  assert.ok(authz, 'authz module should load — install a TS loader if not');
  assert.equal(typeof authz.requirePermission, 'function');
  assert.equal(typeof authz.hasPermission, 'function');
  assert.equal(typeof authz.invalidateRolePermissions, 'function');
});

test('SUPER_ADMIN passes any (resource, action) even with empty matrix', async () => {
  if (!authz) return;
  const { ctx } = makeCtx({
    userId: 'u1',
    userRow: { roleId: 'role_super_admin', roleName: 'SUPER_ADMIN' },
    permissionRows: [], // matrix intentionally empty — bypass should still allow
  });

  let called = false;
  const next = async () => {
    called = true;
  };

  const mw = authz.requirePermission('invoices', 'post');
  await mw(ctx, next);
  assert.equal(called, true, 'next() should be called for SUPER_ADMIN');

  // hasPermission helper too
  const ok = await authz.hasPermission(ctx, 'inventory', 'delete');
  assert.equal(ok, true, 'hasPermission should be true for SUPER_ADMIN');
});

test('READ_ONLY passes (X, "read") for any resource, fails (X, "create")', async () => {
  if (!authz) return;
  const baseCtx = () =>
    makeCtx({
      userId: 'u2',
      userRow: { roleId: 'role_read_only', roleName: 'READ_ONLY' },
      permissionRows: [
        { resource: 'sales-orders', action: 'read' },
        { resource: 'invoices', action: 'read' },
        { resource: 'customers', action: 'read' },
      ],
    });

  // Read should pass.
  {
    const { ctx } = baseCtx();
    let called = false;
    const next = async () => {
      called = true;
    };
    await authz.requirePermission('sales-orders', 'read')(ctx, next);
    assert.equal(called, true, 'READ_ONLY should pass on read');
  }

  // Create should fail with 403.
  {
    const { ctx, getResponse } = baseCtx();
    let called = false;
    const next = async () => {
      called = true;
    };
    await authz.requirePermission('sales-orders', 'create')(ctx, next);
    assert.equal(called, false, 'next() should NOT be called for forbidden');
    const res = getResponse();
    assert.equal(res.status, 403);
    assert.equal(res.body.success, false);
  }
});

test('Unknown / null roleId falls back to READ_ONLY behavior', async () => {
  if (!authz) return;
  // User row with no roleId -> authz must use READ_ONLY default.
  const { ctx } = makeCtx({
    userId: 'u3',
    userRow: { roleId: null, roleName: null },
    // Pretend the read_only role has read on sales-orders (keyed off
    // role_read_only — the fallback id).
    permissionRows: [{ resource: 'sales-orders', action: 'read' }],
  });

  let readCalled = false;
  await authz.requirePermission('sales-orders', 'read')(ctx, async () => {
    readCalled = true;
  });
  assert.equal(readCalled, true, 'unknown role should pass on read');

  // create should still be forbidden.
  const { ctx: ctx2, getResponse } = makeCtx({
    userId: 'u3b',
    userRow: { roleId: null, roleName: null },
    permissionRows: [{ resource: 'sales-orders', action: 'read' }],
  });
  let createCalled = false;
  await authz.requirePermission('sales-orders', 'create')(ctx2, async () => {
    createCalled = true;
  });
  assert.equal(createCalled, false);
  assert.equal(getResponse().status, 403);
});

test('Unauthenticated request returns 401', async () => {
  if (!authz) return;
  const { ctx, getResponse } = makeCtx({
    /* no userId */
  });
  let called = false;
  await authz.requirePermission('invoices', 'read')(ctx, async () => {
    called = true;
  });
  assert.equal(called, false);
  const res = getResponse();
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Unauthorized');
});

test('Permission set is cached on the context — only one perms query for two consecutive checks', async () => {
  if (!authz) return;
  const { ctx, queryCounts } = makeCtx({
    userId: 'u4',
    userRow: { roleId: 'role_finance', roleName: 'FINANCE' },
    permissionRows: [
      { resource: 'invoices', action: 'read' },
      { resource: 'invoices', action: 'create' },
      { resource: 'payments', action: 'read' },
    ],
  });

  await authz.requirePermission('invoices', 'read')(ctx, async () => {});
  await authz.requirePermission('invoices', 'create')(ctx, async () => {});
  await authz.requirePermission('payments', 'read')(ctx, async () => {});

  // user-row lookup should also be cached on ctx (per-request memo).
  assert.equal(queryCounts.user, 1, 'users+roles join should run exactly once');
  assert.equal(queryCounts.perms, 1, 'role_permissions join should run exactly once');
});

test('Cache miss + KV write — second middleware call on a fresh ctx hits KV not D1', async () => {
  if (!authz) return;
  // Share one KV store across two contexts to simulate cross-request caching.
  const sharedKv = new Map();

  function buildCtx(perms) {
    let userQ = 0,
      permQ = 0;
    const dbStub = {
      prepare(sql) {
        const isUser = /FROM users u/i.test(sql);
        const isPerm = /FROM role_permissions rp/i.test(sql);
        return {
          bind() {
            return {
              async first() {
                if (isUser) {
                  userQ += 1;
                  return { roleId: 'role_finance', roleName: 'FINANCE' };
                }
                return null;
              },
              async all() {
                if (isPerm) {
                  permQ += 1;
                  return { results: perms };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    };
    const kvStub = {
      async get(key, opts) {
        const v = sharedKv.get(key);
        if (v === undefined) return null;
        if (opts?.type === 'json') return JSON.parse(v);
        return v;
      },
      async put(key, value) {
        sharedKv.set(key, value);
      },
      async delete(key) {
        sharedKv.delete(key);
      },
    };
    const variables = new Map();
    variables.set('userId', 'shared-user');
    return {
      ctx: {
        var: {
          DB: dbStub,
          get userId() {
            return variables.get('userId');
          },
        },
        env: { AUTHZ_KV: kvStub },
        executionCtx: {
          // Synchronous waitUntil — await inline so the KV write lands before
          // the next assertion.
          waitUntil(p) {
            // We can't await here directly; tests will tick the microtask
            // queue with another await before asserting.
            void p;
          },
        },
        set(k, v) {
          variables.set(k, v);
        },
        get(k) {
          return variables.get(k);
        },
        json(body, status) {
          return { body, status };
        },
      },
      counts: () => ({ userQ, permQ }),
    };
  }

  const perms = [{ resource: 'invoices', action: 'read' }];

  // First request — populates KV.
  const a = buildCtx(perms);
  await authz.requirePermission('invoices', 'read')(a.ctx, async () => {});
  // Yield to let the fire-and-forget KV write complete.
  await new Promise((r) => setImmediate(r));

  assert.equal(a.counts().permQ, 1, 'first ctx queries D1 for perms');
  assert.ok(sharedKv.size >= 1, 'KV should have a cached entry after first call');

  // Second request — KV hit, no D1 perms query.
  const b = buildCtx(perms);
  await authz.requirePermission('invoices', 'read')(b.ctx, async () => {});
  assert.equal(
    b.counts().permQ,
    0,
    'second ctx should NOT query D1 for perms (KV cache hit)',
  );
});

test('invalidateRolePermissions removes the KV entry', async () => {
  if (!authz) return;
  const { ctx, kvStore } = makeCtx({
    userId: 'u5',
    userRow: { roleId: 'role_finance', roleName: 'FINANCE' },
    permissionRows: [{ resource: 'invoices', action: 'read' }],
  });

  await authz.requirePermission('invoices', 'read')(ctx, async () => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(kvStore.size >= 1);

  await authz.invalidateRolePermissions(ctx, 'role_finance');
  assert.equal(kvStore.size, 0, 'invalidateRolePermissions should clear the KV entry');
});
