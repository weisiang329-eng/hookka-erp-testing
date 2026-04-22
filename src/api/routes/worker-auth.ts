// ============================================================
// Worker Auth Route — PIN-based login for the /worker mobile portal
//
// This is the shop-floor-worker entry point, separate from the
// director/admin Firebase/SSO flow. Workers use their empNo + a
// 4-digit PIN that they set themselves on first login.
//
// Storage model (in-memory for now, same mock-data pattern as
// the rest of the app): `pinStore[workerId] = pin`.  In production
// these would be salted+hashed in a proper DB.  A token is a bare
// opaque string we hand back; the worker's browser keeps it in
// localStorage and sends it as `X-Worker-Token` on every call.
// ============================================================
import { Hono } from 'hono';
import { workers } from '../../lib/mock-data';

const app = new Hono();

// In-memory PIN map: workerId → 4-digit PIN string.
// MVP: plaintext since the whole ERP is mock-data. Add hashing
// when the backend moves to a real DB.
const pinStore: Record<string, string> = {};

// In-memory token → workerId map (opaque tokens, ~32 chars).
const tokenStore: Record<string, { workerId: string; issuedAt: number }> = {};

function newToken(): string {
  // 32 char random hex — enough for a mock portal; real prod uses JWT.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ----- POST /api/worker-auth/login -----
// Body: { empNo, pin }
// Returns: { token, worker: { id, empNo, name, departmentCode } }
//
// First-time login (no PIN set yet): body must carry `firstTimePin`.
// That registers the PIN against this empNo. Subsequent logins
// require the same PIN.
app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { empNo, pin, firstTimePin } = body as {
    empNo?: string;
    pin?: string;
    firstTimePin?: string;
  };
  if (!empNo) return c.json({ success: false, error: 'empNo required' }, 400);

  const worker = workers.find(
    (w) => w.empNo.toLowerCase() === empNo.trim().toLowerCase(),
  );
  if (!worker) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }
  if (worker.status !== 'ACTIVE') {
    return c.json({ success: false, error: 'Employee account inactive' }, 403);
  }

  const existingPin = pinStore[worker.id];

  // First-time registration path
  if (!existingPin) {
    if (!firstTimePin || !/^\d{4}$/.test(firstTimePin)) {
      // Tell the client "this empNo has no PIN yet" so it can show
      // the setup screen instead of the login screen.
      return c.json(
        { success: false, error: 'PIN_NOT_SET', needsSetup: true },
        200, // 200 so the client treats it as info, not a failure
      );
    }
    pinStore[worker.id] = firstTimePin;
  } else {
    if (!pin || pin !== existingPin) {
      return c.json({ success: false, error: 'Wrong PIN' }, 401);
    }
  }

  const token = newToken();
  tokenStore[token] = { workerId: worker.id, issuedAt: Date.now() };
  return c.json({
    success: true,
    token,
    worker: {
      id: worker.id,
      empNo: worker.empNo,
      name: worker.name,
      departmentCode: worker.departmentCode,
      position: worker.position,
      phone: worker.phone,
      nationality: worker.nationality,
    },
  });
});

// ----- POST /api/worker-auth/reset-pin -----
// Body: { empNo, phoneLast4, newPin }
// Poor-man's reset: verify empNo + last 4 digits of their stored
// phone number, then overwrite the stored PIN.
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
  const worker = workers.find(
    (w) => w.empNo.toLowerCase() === empNo.trim().toLowerCase(),
  );
  if (!worker) return c.json({ success: false, error: 'Employee not found' }, 404);

  // Strip non-digits from stored phone, compare last 4
  const storedLast4 = (worker.phone || '').replace(/\D/g, '').slice(-4);
  if (!storedLast4 || storedLast4 !== phoneLast4) {
    return c.json({ success: false, error: 'Phone last-4 does not match' }, 401);
  }
  pinStore[worker.id] = newPin;

  // Invalidate any active tokens for this worker — force re-login
  for (const t of Object.keys(tokenStore)) {
    if (tokenStore[t].workerId === worker.id) delete tokenStore[t];
  }

  return c.json({ success: true });
});

// ----- POST /api/worker-auth/logout -----
// Body: { token }  — or X-Worker-Token header.
app.post('/logout', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token =
    c.req.header('x-worker-token') || (body as { token?: string }).token;
  if (token && tokenStore[token]) delete tokenStore[token];
  return c.json({ success: true });
});

// ----- GET /api/worker-auth/me -----
// Resolve the current worker from the token header. Used by the
// portal layout on every page load to refresh the current identity.
app.get('/me', (c) => {
  const token = c.req.header('x-worker-token');
  if (!token || !tokenStore[token]) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  const { workerId } = tokenStore[token];
  const w = workers.find((x) => x.id === workerId);
  if (!w) return c.json({ success: false, error: 'Worker vanished' }, 404);
  return c.json({
    success: true,
    worker: {
      id: w.id,
      empNo: w.empNo,
      name: w.name,
      departmentCode: w.departmentCode,
      position: w.position,
      phone: w.phone,
      nationality: w.nationality,
    },
  });
});

// Helper used by other routes to authenticate worker requests.
// Returns the workerId or null if the token is invalid/missing.
export function resolveWorkerToken(token: string | undefined): string | null {
  if (!token) return null;
  const entry = tokenStore[token];
  return entry ? entry.workerId : null;
}

export default app;
