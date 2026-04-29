// ---------------------------------------------------------------------------
// D1-backed worker-auth route.
//
// Replaces the in-memory pinStore / tokenStore of the old
// src/api/routes/worker-auth.ts with the `worker_pins` and `worker_tokens`
// tables in D1. The HTTP surface (login / reset-pin / logout / me) stays
// identical so the /worker mobile portal needs no changes.
//
// PINs are stored as SHA-256 hex digests (see lib/auth-utils.ts). SHA-256 is
// not salted — PIN space is only 10^4 so rainbow tables are trivial — but it
// keeps raw PINs out of D1. Legacy cleartext rows (from before migration
// 0012) are auto-upgraded in-place the first time the worker logs in
// successfully with them.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { hashPin, isPinHashed } from "../lib/auth-utils";
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
} from "../lib/rate-limit";

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
  "/api/worker-auth/login",
  "/api/worker-auth/reset-pin",
  "/login",
  "/reset-pin",
]);

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (WORKER_AUTH_PUBLIC.has(path)) return next();

  // Inline mini-resolveWorkerToken instead of the exported helper
  // below — at this point in the file the helper isn't defined yet
  // and a forward import would be a cycle. The query is cheap.
  const token = c.req.header("x-worker-token");
  if (!token) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const row = await c.var.DB.prepare(
    "SELECT workerId FROM worker_tokens WHERE token = ?",
  )
    .bind(token)
    .first<{ workerId: string }>();
  if (!row) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  return next();
});

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  position: string | null;
  phone: string | null;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  joinDate: string | null;
  icNumber: string | null;
  passportNumber: string | null;
  nationality: string | null;
};

type PinRow = {
  workerId: string;
  pin: string;
  updatedAt: string | null;
  // Sprint 2: PIN length grew from 4 → 6 digits. Existing 4-digit PINs are
  // flagged must_reset=1 by migration 0079; they must reset to a 6-digit PIN
  // before they can sign in again.
  must_reset: number | null;
};
type TokenRow = { token: string; workerId: string; issuedAt: number };

function newToken(): string {
  // 32 char random hex — opaque bearer token for the worker portal.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function publicWorker(w: WorkerRow) {
  return {
    id: w.id,
    empNo: w.empNo,
    name: w.name,
    departmentCode: w.departmentCode ?? "",
    position: w.position ?? "",
    phone: w.phone ?? "",
    nationality: w.nationality ?? "",
  };
}

// ----- POST /api/worker-auth/login -----
// Body: { empNo, pin, firstTimePin? }
// Returns: { token, worker: { id, empNo, name, departmentCode, position, phone, nationality } }
//
// First-time login (no PIN set yet): body must carry `firstTimePin`.
// That registers the PIN against this worker. Subsequent logins require the same PIN.
app.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { empNo, pin, firstTimePin } = body as {
    empNo?: string;
    pin?: string;
    firstTimePin?: string;
  };
  if (!empNo) return c.json({ success: false, error: "empNo required" }, 400);

  // Brute-force throttle — 10 attempts / 15 min keyed on empNo. PINs are
  // 6 digits (10^6 search space) but a tight bot loop could still try every
  // PIN against a stolen empNo within minutes — this caps the dollar cost.
  const rlKey = `wlogin:${empNo.trim().toLowerCase()}`;
  const rlDenied = await checkLoginRateLimit(c, rlKey);
  if (rlDenied) return rlDenied;

  // Match by case-insensitive empNo.
  const worker = await c.var.DB.prepare(
    "SELECT * FROM workers WHERE LOWER(empNo) = LOWER(?) LIMIT 1",
  )
    .bind(empNo.trim())
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: "Employee not found" }, 404);
  }
  if (worker.status !== "ACTIVE") {
    return c.json({ success: false, error: "Employee account inactive" }, 403);
  }

  const existing = await c.var.DB.prepare(
    "SELECT * FROM worker_pins WHERE workerId = ?",
  )
    .bind(worker.id)
    .first<PinRow>();

  // First-time registration path.
  if (!existing) {
    if (!firstTimePin || !/^\d{6}$/.test(firstTimePin)) {
      // 200 so the client treats it as info, not a failure, and shows the setup screen.
      return c.json(
        { success: false, error: "PIN_NOT_SET", needsSetup: true },
        200,
      );
    }
    const hashed = await hashPin(firstTimePin);
    await c.var.DB.prepare(
      "INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, 0)",
    )
      .bind(worker.id, hashed, new Date().toISOString())
      .run();
  } else {
    // Sprint 2 — force-reset gate. Workers whose stored PIN is from the old
    // 4-digit era (must_reset=1, set by migration 0079) must run the reset
    // flow before logging in. The portal UI handles this by surfacing the
    // reset-PIN screen when needsReset=true comes back.
    if (existing.must_reset === 1) {
      return c.json(
        {
          success: false,
          error: "PIN_RESET_REQUIRED",
          needsReset: true,
        },
        200,
      );
    }
    if (!pin) {
      return c.json({ success: false, error: "Wrong PIN" }, 401);
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
      return c.json({ success: false, error: "Wrong PIN" }, 401);
    }
    if (!storedIsHashed) {
      await c.var.DB.prepare(
        "UPDATE worker_pins SET pin = ?, updatedAt = ? WHERE workerId = ?",
      )
        .bind(submittedHash, new Date().toISOString(), worker.id)
        .run();
    }
  }

  const token = newToken();
  await c.var.DB.prepare(
    "INSERT INTO worker_tokens (token, workerId, issuedAt) VALUES (?, ?, ?)",
  )
    .bind(token, worker.id, Date.now())
    .run();

  // Reset the rate-limit counter on success. waitUntil is best-effort —
  // when running outside a Worker (tests, local node), `executionCtx`
  // throws on access, so we fall back to fire-and-forget. The cleanup is
  // idempotent and a missed reset just costs the next 15-min window.
  try {
    c.executionCtx.waitUntil(clearLoginRateLimit(c, rlKey));
  } catch {
    void clearLoginRateLimit(c, rlKey).catch(() => {});
  }

  return c.json({
    success: true,
    token,
    worker: publicWorker(worker),
  });
});

// ----- POST /api/worker-auth/reset-pin -----
// Body: { empNo, phoneLast4, newPin }
// Poor-man's reset: verify empNo + last 4 digits of stored phone, then
// overwrite stored PIN and invalidate all active tokens for this worker.
app.post("/reset-pin", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { empNo, phoneLast4, newPin } = body as {
    empNo?: string;
    phoneLast4?: string;
    newPin?: string;
  };
  if (!empNo || !phoneLast4 || !newPin) {
    return c.json({ success: false, error: "Missing fields" }, 400);
  }
  if (!/^\d{6}$/.test(newPin)) {
    return c.json({ success: false, error: "PIN must be 6 digits" }, 400);
  }

  // Brute-force throttle — 10 attempts / 15 min keyed on empNo. The
  // phoneLast4 verifier only has 10^4 entropy so it must be rate-limited.
  const rlKey = `wreset:${empNo.trim().toLowerCase()}`;
  const rlDenied = await checkLoginRateLimit(c, rlKey);
  if (rlDenied) return rlDenied;

  const worker = await c.var.DB.prepare(
    "SELECT * FROM workers WHERE LOWER(empNo) = LOWER(?) LIMIT 1",
  )
    .bind(empNo.trim())
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: "Employee not found" }, 404);
  }

  // Strip non-digits from stored phone, compare last 4.
  const storedLast4 = (worker.phone || "").replace(/\D/g, "").slice(-4);
  if (!storedLast4 || storedLast4 !== phoneLast4) {
    return c.json(
      { success: false, error: "Phone last-4 does not match" },
      401,
    );
  }

  const hashedNew = await hashPin(newPin);
  await c.var.DB.prepare(
    `INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, 0)
     ON CONFLICT (workerId) DO UPDATE SET pin = EXCLUDED.pin, updatedAt = EXCLUDED.updatedAt, must_reset = 0`,
  )
    .bind(worker.id, hashedNew, new Date().toISOString())
    .run();

  // Invalidate any active tokens for this worker — force re-login.
  await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
    .bind(worker.id)
    .run();

  return c.json({ success: true });
});

// ----- POST /api/worker-auth/logout -----
// Body: { token }  — or X-Worker-Token header.
app.post("/logout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token =
    c.req.header("x-worker-token") || (body as { token?: string }).token;
  if (token) {
    await c.var.DB.prepare("DELETE FROM worker_tokens WHERE token = ?")
      .bind(token)
      .run();
  }
  return c.json({ success: true });
});

// ----- GET /api/worker-auth/me -----
// Resolve the current worker from the token header. Used by the portal
// layout on every page load to refresh the current identity.
app.get("/me", async (c) => {
  const token = c.req.header("x-worker-token");
  if (!token) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const row = await c.var.DB.prepare(
    "SELECT * FROM worker_tokens WHERE token = ?",
  )
    .bind(token)
    .first<TokenRow>();
  if (!row) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const worker = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(row.workerId)
    .first<WorkerRow>();
  if (!worker) {
    return c.json({ success: false, error: "Worker vanished" }, 404);
  }
  return c.json({ success: true, worker: publicWorker(worker) });
});

// Helper used by other routes to authenticate worker requests.
// Returns the workerId or null if the token is invalid/missing.
// Now async because it must query D1.
export async function resolveWorkerToken(
  db: D1Database,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const row = await db
    .prepare("SELECT workerId FROM worker_tokens WHERE token = ?")
    .bind(token)
    .first<{ workerId: string }>();
  return row ? row.workerId : null;
}

export default app;
