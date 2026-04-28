// ---------------------------------------------------------------------------
// worker-auth.test.mjs — unit tests for src/api/routes/worker-auth.ts (P3.5).
//
// Verifies that the D1-backed pin/session model survives a Worker cold-start.
// Cold-start is simulated by re-importing the module after the previous
// module-scope state would have been gone — but with D1 backing, no module
// state exists, so persistence is purely a property of the (stubbed) DB
// surviving across the two import calls.
//
// Same node:test pattern as tests/authz.test.mjs:
//   - tsx loader registered so the .ts module loads cleanly on Node 20+.
//   - All DB interaction uses an in-memory SQLite-ish stub that mimics the
//     prepare/bind/run/first surface c.var.DB exposes in production.
//
// Coverage:
//   1. Login + verify token survives a fresh "Worker process".
//      (Same DB stub; new module instance — module-scope state is absent
//      so the only persistence signal is the DB.)
//   2. Logout invalidates the token.
//   3. Reset-pin invalidates ALL of the worker's tokens.
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
  // fails loudly — that is the right behavior.
}

// ---- Tiny in-memory SQLite-ish stub ----------------------------------------
//
// Just enough surface to back worker_pins / worker_tokens / workers reads.
// Routes the SQL through a small pattern-match dispatch table; not a real
// SQL engine. Keeps the test's assertions on observable behavior, not on
// query string formatting.

function makeDb({ workers: workerSeed = [] } = {}) {
  // Tables.
  const workers = new Map();   // id -> row
  const pins = new Map();      // workerId -> { workerId, pin, updatedAt }
  const sessions = new Map();  // token -> { token, workerId, createdAt, expiresAt, lastSeenAt }

  for (const w of workerSeed) {
    workers.set(w.id, { ...w });
  }

  function prepare(sql) {
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        const s = sql.trim();
        // SELECT ... FROM workers WHERE LOWER(empNo) = LOWER(?) LIMIT 1
        if (/FROM workers WHERE LOWER\(empNo\)/i.test(s)) {
          const target = String(bound[0] || '').toLowerCase();
          for (const w of workers.values()) {
            if ((w.empNo || '').toLowerCase() === target) return w;
          }
          return null;
        }
        // SELECT ... FROM workers WHERE id = ?
        if (/FROM workers WHERE id = \?/.test(s)) {
          return workers.get(bound[0]) || null;
        }
        // SELECT ... FROM worker_pins WHERE workerId = ?
        if (/FROM worker_pins WHERE workerId = \?/.test(s)) {
          return pins.get(bound[0]) || null;
        }
        // SELECT workerId FROM worker_tokens WHERE token = ?  (auth middleware)
        // SELECT * FROM worker_tokens WHERE token = ?          (/me handler)
        if (/FROM worker_tokens WHERE token = \?/i.test(s)) {
          const row = sessions.get(bound[0]);
          if (!row) return null;
          // Tests expect both shapes — full row OR { workerId } subset.
          return row;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        const s = sql.trim();
        // INSERT INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)
        if (/INSERT INTO worker_pins/i.test(s) && !/ON CONFLICT/i.test(s)) {
          const [workerId, pin, updatedAt] = bound;
          pins.set(workerId, { workerId, pin, updatedAt });
          return { success: true };
        }
        // INSERT ... ON CONFLICT (workerId) DO UPDATE
        if (/INSERT INTO worker_pins/i.test(s) && /ON CONFLICT/i.test(s)) {
          const [workerId, pin, updatedAt] = bound;
          pins.set(workerId, { workerId, pin, updatedAt });
          return { success: true };
        }
        // UPDATE worker_pins SET pin = ?, updatedAt = ? WHERE workerId = ?
        if (/UPDATE worker_pins SET pin/i.test(s)) {
          const [pin, updatedAt, workerId] = bound;
          const row = pins.get(workerId);
          if (row) {
            row.pin = pin;
            row.updatedAt = updatedAt;
          }
          return { success: true };
        }
        // INSERT INTO worker_tokens (token, workerId, issuedAt) VALUES (?, ?, ?)
        if (/INSERT INTO worker_tokens/i.test(s)) {
          const [token, workerId, issuedAt] = bound;
          sessions.set(token, { token, workerId, issuedAt });
          return { success: true };
        }
        // DELETE FROM worker_tokens WHERE token = ?
        if (/DELETE FROM worker_tokens WHERE token = \?/i.test(s)) {
          sessions.delete(bound[0]);
          return { success: true };
        }
        // DELETE FROM worker_tokens WHERE workerId = ?
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

  return {
    db: { prepare },
    // Test-side accessors for assertions.
    _state: { workers, pins, sessions },
  };
}

// Shared seed across the suite — one ACTIVE worker.
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

// Helper: invoke a Hono route handler with a fresh stub Context. Hono's
// app.request() needs the DB available via c.var.DB, which Hono populates
// from middleware. We do not run the full middleware chain — instead we
// use the lower-level handler dispatch by constructing a stub Context.

import { Hono } from 'hono';

// Wrap the route module in a parent Hono app so we can install the
// DB-binding middleware *before* the route handlers dispatch. (Hono
// builds its router lazily on first request — registering middleware
// on the route module itself after import does not always run before
// the route handlers, so a parent-app wrapper is the reliable shape.)
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
  const initHeaders = { 'content-type': 'application/json', ...headers };
  const init = {
    method,
    headers: initHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  return app.request(path, init, { DB: db });
}

// ---- Tests -----------------------------------------------------------------

test('module loads', async () => {
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=load'
  );
  assert.ok(mod, 'worker-auth module should load');
  assert.equal(typeof mod.resolveWorkerToken, 'function');
  assert.equal(typeof mod.default, 'object');
  // Hono apps expose request().
  assert.equal(typeof mod.default.request, 'function');
  void loaderRegistered;
});

test('login + token survives a fresh Worker process (D1 stub shared across imports)', async () => {
  const { db } = makeDb({ workers: [WORKER] });

  // Process A — import the module, register PIN, log in, get a token.
  const modA = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=A'
  );
  // Wrap the route module with a tiny middleware that copies env.DB to var.DB
  // (production middleware does the same — see src/api/worker.ts).
  const appA = wrap(modA.default);

  // First-time PIN registration.
  let res = await callRoute(
    appA,
    { method: 'POST', path: '/login', body: { empNo: 'EMP001', firstTimePin: '1234' } },
    db,
  );
  let json = await res.json();
  assert.equal(json.success, true, 'first-time login should succeed');
  assert.ok(json.token, 'token should be returned');
  const tokenA = json.token;

  // Process B — fresh module instance. In production this is a Worker cold
  // start: module-scope state is wiped. Same DB stub stands in for the
  // persistent D1 binding that Cloudflare hands the new isolate.
  const modB = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=B'
  );
  const appB = wrap(modB.default);

  // /me with the token from process A — must still authenticate.
  res = await callRoute(
    appB,
    { method: 'GET', path: '/me', headers: { 'x-worker-token': tokenA } },
    db,
  );
  json = await res.json();
  assert.equal(json.success, true, 'token should survive into a fresh module');
  assert.equal(json.worker.id, WORKER.id);

  // resolveWorkerToken (the helper exported for cross-route use) too.
  const resolved = await modB.resolveWorkerToken(db, tokenA);
  assert.equal(resolved, WORKER.id, 'resolveWorkerToken should resolve across processes');
});

test('logout invalidates the token', async () => {
  const { db } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=logout'
  );
  const app = wrap(mod.default);

  // Register + login.
  let res = await callRoute(
    app,
    { method: 'POST', path: '/login', body: { empNo: 'EMP001', firstTimePin: '4321' } },
    db,
  );
  const { token } = await res.json();
  assert.ok(token);

  // Verify it works.
  res = await callRoute(
    app,
    { method: 'GET', path: '/me', headers: { 'x-worker-token': token } },
    db,
  );
  assert.equal((await res.json()).success, true);

  // Log out.
  res = await callRoute(
    app,
    { method: 'POST', path: '/logout', headers: { 'x-worker-token': token } },
    db,
  );
  assert.equal((await res.json()).success, true);

  // /me should now 401.
  res = await callRoute(
    app,
    { method: 'GET', path: '/me', headers: { 'x-worker-token': token } },
    db,
  );
  const after = await res.json();
  assert.equal(after.success, false);
  assert.equal(res.status, 401);

  // resolveWorkerToken too.
  assert.equal(await mod.resolveWorkerToken(db, token), null);
});

test('reset-pin invalidates ALL of the workers tokens', async () => {
  const { db, _state } = makeDb({ workers: [WORKER] });
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), 'src/api/routes/worker-auth.ts'),
    ).href + '?t=reset'
  );
  const app = wrap(mod.default);

  // First-time login.
  let res = await callRoute(
    app,
    { method: 'POST', path: '/login', body: { empNo: 'EMP001', firstTimePin: '0000' } },
    db,
  );
  const tokenA = (await res.json()).token;
  assert.ok(tokenA);

  // Second login from the "phone" — same PIN, second active session.
  res = await callRoute(
    app,
    { method: 'POST', path: '/login', body: { empNo: 'EMP001', pin: '0000' } },
    db,
  );
  const tokenB = (await res.json()).token;
  assert.ok(tokenB);
  assert.notEqual(tokenA, tokenB);

  // Sanity — both authenticate.
  for (const t of [tokenA, tokenB]) {
    res = await callRoute(
      app,
      { method: 'GET', path: '/me', headers: { 'x-worker-token': t } },
      db,
    );
    assert.equal((await res.json()).success, true);
  }

  // 2 sessions in the DB, both for our worker.
  const beforeReset = [..._state.sessions.values()].filter(
    (s) => s.workerId === WORKER.id,
  );
  assert.equal(beforeReset.length, 2);

  // Reset PIN — verify phone last 4.
  res = await callRoute(
    app,
    {
      method: 'POST',
      path: '/reset-pin',
      body: { empNo: 'EMP001', phoneLast4: '6789', newPin: '9999' },
    },
    db,
  );
  assert.equal((await res.json()).success, true);

  // Both old tokens dead.
  for (const t of [tokenA, tokenB]) {
    res = await callRoute(
      app,
      { method: 'GET', path: '/me', headers: { 'x-worker-token': t } },
      db,
    );
    const j = await res.json();
    assert.equal(j.success, false);
    assert.equal(res.status, 401);
  }

  // No surviving sessions for that worker.
  const afterReset = [..._state.sessions.values()].filter(
    (s) => s.workerId === WORKER.id,
  );
  assert.equal(afterReset.length, 0);
});
