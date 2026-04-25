// ============================================================
// Worker Auth Route — PIN-based login for the /worker mobile portal
//
// This is the shop-floor-worker entry point, separate from the
// director/admin Firebase/SSO flow. Workers use their empNo + a
// 4-digit PIN that they set themselves on first login.
//
// Storage model (P3.5 — D1-backed; replaces the old in-memory
// `pinStore` / `tokenStore` Maps that died on every Worker
// cold-start):
//   - worker_pins      — one row per worker, holds the SHA-256
//                        hex of the PIN. Already existed before
//                        this migration (see 0001_init.sql).
//   - worker_sessions  — one row per active token. New table in
//                        migration 0048_worker_sessions.sql.
//                        Token is the primary key; sessions carry
//                        createdAt / expiresAt (now + 30d) /
//                        lastSeenAt for idle-aging.
//
// PINs are stored as SHA-256 hex digests (see ../lib/auth-utils.ts).
// SHA-256 is NOT salted — PIN space is only 10^4 so rainbow tables
// are trivial — but it keeps raw PINs out of D1. Real worker auth
// should pair this with route-level rate limiting (TODO: separate
// task) and migrate to PBKDF2 + per-worker salt when the shop floor
// moves beyond convenience login.
//
// Legacy cleartext rows (from before the hashing migration) are
// auto-upgraded in-place the first time the worker logs in
// successfully with them.
// ============================================================
import { Hono } from 'hono';
import type { Env } from '../worker';
import { hashPin, isPinHashed } from '../lib/auth-utils';

const app = new Hono<Env>();

// ============================================================
// Default-protect middleware (audit S2 — closes the "new endpoint
// added under /api/worker-auth without auth" exposure class).
//
// The global authMiddleware exempts the entire /api/worker-auth/
// prefix so login can run without a Bearer token. That worked when
// the only public endpoints here were login/reset-pin, but new
// endpoints (logout, future "rotate-token", etc.) inherit that
// exemption automatically.
//
// Fix: list the routes that MUST stay public in WORKER_AUTH_PUBLIC
// and require a valid X-Worker-Token for everything else.
// ============================================================
// Both the mounted path (production) and the bare sub-app path are listed
// so the middleware behaves identically whether the app is mounted at
// /api/worker-auth (production) or at "/" (unit tests / future remounts).
const WORKER_AUTH_PUBLIC: ReadonlySet<string> = new Set<string>([
  '/api/worker-auth/login',
  '/api/worker-auth/reset-pin',
  '/login',
  '/reset-pin',
]);

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (WORKER_AUTH_PUBLIC.has(path)) return next();

  // Inline mini-resolveWorkerToken instead of the exported helper
  // below — at this point in the file the helper isn't defined yet,
  // and importing it would be a cycle. Cheap enough to inline.
  const token = c.req.header('x-worker-token');
  if (!token) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  const nowIso = new Date().toISOString();
  const row = await c.var.DB.prepare(
    'SELECT workerId FROM worker_sessions WHERE token = ? AND expiresAt > ?',
  )
    .bind(token, nowIso)
    .first<{ workerId: string }>();
  if (!row) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  return next();
});

// Session lifetime — 30 days. Same value used by the director/admin
// JWT cookie so workers feel a single coherent "stay logged in" rule.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  position: string | null;
  phone: string | null;
  status: string;
  nationality: string | null;
};

type PinRow = { workerId: string; pin: string; updatedAt: string | null };
type SessionRow = {
  token: string;
  workerId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
};

function newToken(): string {
  // 32 char random hex — opaque bearer token for the worker portal.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function publicWorker(w: WorkerRow) {
  return {
    id: w.id,
    empNo: w.empNo,
    name: w.name,
    departmentCode: w.departmentCode ?? '',
    position: w.position ?? '',
    phone: w.phone ?? '',
    nationality: w.nationality ?? '',
  };
}

// ----- POST /api/worker-auth/login -----
// Body: { empNo, pin, firstTimePin? }
// Returns: { token, worker: { id, empNo, name, departmentCode, position, phone, nationality } }
//
// First-time login (no PIN set yet): body must carry `firstTimePin`.
// That registers the PIN against this worker. Subsequent logins
// require the same PIN.
app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { empNo, pin, firstTimePin } = body as {
    empNo?: string;
    pin?: string;
    firstTimePin?: string;
  };
  if (!empNo) return c.json({ success: false, error: 'empNo required' }, 400);

  // Match by case-insensitive empNo.
  const worker = await c.var.DB.prepare(
    'SELECT id, empNo, name, departmentId, departmentCode, position, phone, status, nationality FROM workers WHERE LOWER(empNo) = LOWER(?) LIMIT 1',
  )
    .bind(empNo.trim())
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }
  if (worker.status !== 'ACTIVE') {
    return c.json({ success: false, error: 'Employee account inactive' }, 403);
  }

  const existing = await c.var.DB.prepare(
    'SELECT workerId, pin, updatedAt FROM worker_pins WHERE workerId = ?',
  )
    .bind(worker.id)
    .first<PinRow>();

  // First-time registration path.
  if (!existing) {
    if (!firstTimePin || !/^\d{4}$/.test(firstTimePin)) {
      // 200 so the client treats it as info, not a failure, and shows
      // the setup screen.
      return c.json(
        { success: false, error: 'PIN_NOT_SET', needsSetup: true },
        200,
      );
    }
    const hashed = await hashPin(firstTimePin);
    await c.var.DB.prepare(
      'INSERT INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)',
    )
      .bind(worker.id, hashed, new Date().toISOString())
      .run();
  } else {
    if (!pin) {
      return c.json({ success: false, error: 'Wrong PIN' }, 401);
    }
    // Back-compat: rows predating the hashing migration still hold cleartext
    // PINs. On a successful match rewrite them to SHA-256 so the next login
    // takes the fast path. After a full rollout + cleanup this branch can be
    // removed.
    const submittedHash = await hashPin(pin);
    const storedIsHashed = isPinHashed(existing.pin);
    const matches = storedIsHashed
      ? submittedHash === existing.pin
      : pin === existing.pin;
    if (!matches) {
      return c.json({ success: false, error: 'Wrong PIN' }, 401);
    }
    if (!storedIsHashed) {
      await c.var.DB.prepare(
        'UPDATE worker_pins SET pin = ?, updatedAt = ? WHERE workerId = ?',
      )
        .bind(submittedHash, new Date().toISOString(), worker.id)
        .run();
    }
  }

  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await c.var.DB.prepare(
    'INSERT INTO worker_sessions (token, workerId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(token, worker.id, now.toISOString(), expiresAt, now.toISOString())
    .run();

  return c.json({
    success: true,
    token,
    worker: publicWorker(worker),
  });
});

// ----- POST /api/worker-auth/reset-pin -----
// Body: { empNo, phoneLast4, newPin }
// Poor-man's reset: verify empNo + last 4 digits of stored phone, then
// overwrite stored PIN and invalidate all active sessions for this worker.
app.post('/reset-pin', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { empNo, phoneLast4, newPin } = body as {
    empNo?: string;
    phoneLast4?: string;
    newPin?: string;
  };
  if (!empNo || !phoneLast4 || !newPin) {
    return c.json({ success: false, error: 'Missing fields' }, 400);
  }
  if (!/^\d{4}$/.test(newPin)) {
    return c.json({ success: false, error: 'PIN must be 4 digits' }, 400);
  }

  const worker = await c.var.DB.prepare(
    'SELECT id, empNo, name, departmentId, departmentCode, position, phone, status, nationality FROM workers WHERE LOWER(empNo) = LOWER(?) LIMIT 1',
  )
    .bind(empNo.trim())
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  // Strip non-digits from stored phone, compare last 4.
  const storedLast4 = (worker.phone || '').replace(/\D/g, '').slice(-4);
  if (!storedLast4 || storedLast4 !== phoneLast4) {
    return c.json(
      { success: false, error: 'Phone last-4 does not match' },
      401,
    );
  }

  const hashedNew = await hashPin(newPin);
  await c.var.DB.prepare(
    `INSERT INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT (workerId) DO UPDATE SET pin = excluded.pin, updatedAt = excluded.updatedAt`,
  )
    .bind(worker.id, hashedNew, new Date().toISOString())
    .run();

  // Invalidate ALL active sessions for this worker — force re-login on
  // every device. This is the security-critical contract of reset-pin:
  // if you rotate the credential, every old cookie dies.
  await c.var.DB.prepare('DELETE FROM worker_sessions WHERE workerId = ?')
    .bind(worker.id)
    .run();

  return c.json({ success: true });
});

// ----- POST /api/worker-auth/logout -----
// Body: { token }  — or X-Worker-Token header.
app.post('/logout', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token =
    c.req.header('x-worker-token') || (body as { token?: string }).token;
  if (token) {
    await c.var.DB.prepare('DELETE FROM worker_sessions WHERE token = ?')
      .bind(token)
      .run();
  }
  return c.json({ success: true });
});

// ----- GET /api/worker-auth/me -----
// Resolve the current worker from the token header. Used by the portal
// layout on every page load to refresh the current identity.
app.get('/me', async (c) => {
  const token = c.req.header('x-worker-token');
  if (!token) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  const nowIso = new Date().toISOString();
  const session = await c.var.DB.prepare(
    'SELECT token, workerId, createdAt, expiresAt, lastSeenAt FROM worker_sessions WHERE token = ? AND expiresAt > ?',
  )
    .bind(token, nowIso)
    .first<SessionRow>();
  if (!session) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  const worker = await c.var.DB.prepare(
    'SELECT id, empNo, name, departmentId, departmentCode, position, phone, status, nationality FROM workers WHERE id = ?',
  )
    .bind(session.workerId)
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: 'Worker vanished' }, 404);
  }

  // Bump lastSeenAt — useful for idle-token telemetry. Best-effort: a
  // failure here should not deny the request.
  try {
    await c.var.DB.prepare(
      'UPDATE worker_sessions SET lastSeenAt = ? WHERE token = ?',
    )
      .bind(nowIso, token)
      .run();
  } catch {
    // swallow — verifying the session is the priority, telemetry is gravy
  }

  return c.json({ success: true, worker: publicWorker(worker) });
});

// Helper used by other routes to authenticate worker requests.
// Returns the workerId or null if the token is invalid / missing / expired.
// Async because it must hit D1; callers that previously called the
// in-memory sync version need to `await` and pass the request's `c.var.DB`.
export async function resolveWorkerToken(
  db: D1Database,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      'SELECT workerId FROM worker_sessions WHERE token = ? AND expiresAt > ?',
    )
    .bind(token, nowIso)
    .first<{ workerId: string }>();
  return row ? row.workerId : null;
}

export default app;
