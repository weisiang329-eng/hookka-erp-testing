// ---------------------------------------------------------------------------
// worker-auth-default-protect.test.mjs — audit S2 regression suite.
//
// The /api/worker/* and /api/worker-auth/* sub-apps used to self-police
// authentication by having every handler call requireWorker(c) at the top.
// The risk: a future handler added to the sub-app forgets the call and gets
// silently exposed unauthenticated, because the global authMiddleware
// exempts both prefixes via PUBLIC_PREFIXES in lib/auth-middleware.ts.
//
// Fix (this PR): each sub-app now installs its own `app.use('*')` middleware
// that requires X-Worker-Token by default and only lets paths in an explicit
// allowlist through (login + reset-pin under /api/worker-auth, nothing under
// /api/worker today).
//
// These tests verify:
//   1. /api/worker/* refuses an unauthenticated request (401).
//   2. /api/worker-auth/login still works without a token.
//   3. /api/worker-auth/reset-pin still works without a token.
//   4. /api/worker-auth/logout NOW requires a token (401 without one).
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
  // Native type-stripping (Node 22.6+) handles the .ts import without a
  // loader. If both fail, the dynamic import below throws and the suite
  // fails loudly — which is the right behavior.
}
void loaderRegistered;

// ---- Tiny in-memory SQLite-ish stub ----------------------------------------
//
// Backs worker_pins / worker_tokens / workers reads with the minimum
// surface needed by routes/worker-auth.ts and routes/worker.ts. Routes the
// SQL through a small pattern-match dispatch table; not a real engine.

function makeDb({ workers: workerSeed = [] } = {}) {
  const workers = new Map();
  const pins = new Map();
  const sessions = new Map();

  for (const w of workerSeed) workers.set(w.id, { ...w });

  function prepare(sql) {
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        const s = sql.trim();
        if (/FROM workers WHERE LOWER\(empNo\)/i.test(s)) {
          const target = String(bound[0] || '').toLowerCase();
          for (const w of workers.values()) {
            if ((w.empNo || '').toLowerCase() === target) return w;
          }
          return null;
        }
        if (/FROM workers WHERE id = \?/.test(s)) {
          return workers.get(bound[0]) || null;
        }
        if (/FROM worker_pins WHERE workerId = \?/.test(s)) {
          return pins.get(bound[0]) || null;
        }
        if (/FROM worker_tokens WHERE token = \?/i.test(s)) {
          const row = sessions.get(bound[0]);
          if (!row) return null;
          return row;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        const s = sql.trim();
        if (/INSERT INTO worker_pins/i.test(s)) {
          const [workerId, pin, updatedAt] = bound;
          pins.set(workerId, { workerId, pin, updatedAt });
          return { success: true };
        }
        if (/UPDATE worker_pins SET pin/i.test(s)) {
          const [pin, updatedAt, workerId] = bound;
          const row = pins.get(workerId);
          if (row) {
            row.pin = pin;
            row.updatedAt = updatedAt;
          }
          return { success: true };
        }
        if (/INSERT INTO worker_tokens/i.test(s)) {
          const [token, workerId, issuedAt] = bound;
          sessions.set(token, { token, workerId, issuedAt });
          return { success: true };
        }
        if (/DELETE FROM worker_tokens WHERE token = \?/i.test(s)) {
          sessions.delete(bound[0]);
          return { success: true };
        }
        if (/DELETE FROM worker_tokens WHERE workerId = \?/i.test(s)) {
          const wId = bound[0];
          for (const t of [...sessions.keys()]) {
            if (sessions.get(t).workerId === wId) sessions.delete(t);
          }
          return { success: true };
        }
        return { success: true };
      },
    };
    return obj;
  }

  return { db: { prepare }, _state: { workers, pins, sessions } };
}

// Wrap a route module in a parent Hono app that installs the standard
// DB-binding middleware (production worker.ts does the same).

import { Hono } from 'hono';

function wrap(routeApp) {
  const parent = new Hono();
  parent.use('*', async (c, next) => {
    c.set('DB', c.env?.DB);
    await next();
  });
  parent.route('/', routeApp);
  return parent;
}

async function callRoute(app, { method, path, body, headers = {} }, db) {
  const init = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  return app.request(path, init, { DB: db });
}

const WORKER = {
  id: 'worker-1',
  empNo: 'EMP001',
  name: 'Test Worker',
  departmentId: 'dept-1',
  departmentCode: 'FAB_CUT',
  position: 'Operator',
  phone: '+60-12-345-6789',
  status: 'ACTIVE',
  nationality: 'MY',
};

// ---- Tests -----------------------------------------------------------------

// NOTE: the legacy `src/api/routes/worker.ts` sub-app was removed during
// the worker-portal consolidation; what used to live there now sits under
// /api/worker-auth/* + the per-resource routes. The two tests that
// imported it have been replaced by an equivalent shape against
// worker-auth.ts, which is the surviving sub-app with the
// default-protect middleware.
test('worker-auth sub-app: an unmapped path also rejects unauthenticated (default-protect)', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=auth-unmapped'
  );
  const app = wrap(mod.default);

  // Hit a path that does NOT exist as a registered handler — the
  // default-protect middleware should still 401 because it runs
  // before route matching. (If the middleware were missing, Hono
  // would respond 404 unauthenticated.)
  const res = await callRoute(
    app,
    { method: 'GET', path: '/scan-something' },
    db,
  );
  assert.equal(
    res.status,
    401,
    'unauthenticated unmapped path must be rejected by default-protect middleware',
  );
});

test('worker-auth sub-app: /me without token rejects (registered handler still gated)', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=me-anon'
  );
  const app = wrap(mod.default);

  const res = await callRoute(
    app,
    { method: 'GET', path: '/me' },
    db,
  );
  assert.equal(res.status, 401, '/me without token must 401');
});

test('worker-auth sub-app: /login still works without auth', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=login-public'
  );
  const app = wrap(mod.default);

  const res = await callRoute(
    app,
    {
      method: 'POST',
      path: '/login',
      body: { empNo: 'EMP001', firstTimePin: '1234' },
    },
    db,
  );
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.success, true, 'first-time login should succeed without a token');
  assert.ok(json.token, 'token returned on successful login');
});

test('worker-auth sub-app: /reset-pin still works without auth', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  // Pre-seed a pin so we have something to reset (also exercises the
  // ON CONFLICT branch of reset-pin's INSERT).
  await db
    .prepare('INSERT INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)')
    .bind(WORKER.id, 'sha-of-something', '2026-01-01T00:00:00.000Z')
    .run();

  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=reset-public'
  );
  const app = wrap(mod.default);

  const res = await callRoute(
    app,
    {
      method: 'POST',
      path: '/reset-pin',
      body: { empNo: 'EMP001', phoneLast4: '6789', newPin: '9999' },
    },
    db,
  );
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.success, true, 'reset-pin should succeed without a token');
});

test('worker-auth sub-app: /logout NOW requires auth (was previously public)', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=logout-protected'
  );
  const app = wrap(mod.default);

  // No token → middleware rejects.
  let res = await callRoute(app, { method: 'POST', path: '/logout' }, db);
  assert.equal(
    res.status,
    401,
    '/logout without a token should now 401 (default-protect)',
  );

  // Acquire a real token via /login, then /logout works.
  res = await callRoute(
    app,
    {
      method: 'POST',
      path: '/login',
      body: { empNo: 'EMP001', firstTimePin: '0000' },
    },
    db,
  );
  const { token } = await res.json();
  assert.ok(token);

  res = await callRoute(
    app,
    {
      method: 'POST',
      path: '/logout',
      headers: { 'x-worker-token': token },
    },
    db,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.success, true);
});
