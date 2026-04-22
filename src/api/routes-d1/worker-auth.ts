// ---------------------------------------------------------------------------
// D1-backed worker-auth route.
//
// Replaces the in-memory pinStore / tokenStore of the old
// src/api/routes/worker-auth.ts with the `worker_pins` and `worker_tokens`
// tables in D1. The HTTP surface (login / reset-pin / logout / me) stays
// identical so the /worker mobile portal needs no changes.
//
// PINs are still stored as plaintext (shop-floor convenience login, not real
// auth) — when this matures into real auth it should be bcrypt-hashed here.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

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

type PinRow = { workerId: string; pin: string; updatedAt: string | null };
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

  // Match by case-insensitive empNo.
  const worker = await c.env.DB.prepare(
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

  const existing = await c.env.DB.prepare(
    "SELECT * FROM worker_pins WHERE workerId = ?",
  )
    .bind(worker.id)
    .first<PinRow>();

  // First-time registration path.
  if (!existing) {
    if (!firstTimePin || !/^\d{4}$/.test(firstTimePin)) {
      // 200 so the client treats it as info, not a failure, and shows the setup screen.
      return c.json(
        { success: false, error: "PIN_NOT_SET", needsSetup: true },
        200,
      );
    }
    await c.env.DB.prepare(
      "INSERT INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)",
    )
      .bind(worker.id, firstTimePin, new Date().toISOString())
      .run();
  } else {
    if (!pin || pin !== existing.pin) {
      return c.json({ success: false, error: "Wrong PIN" }, 401);
    }
  }

  const token = newToken();
  await c.env.DB.prepare(
    "INSERT INTO worker_tokens (token, workerId, issuedAt) VALUES (?, ?, ?)",
  )
    .bind(token, worker.id, Date.now())
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
  if (!/^\d{4}$/.test(newPin)) {
    return c.json({ success: false, error: "PIN must be 4 digits" }, 400);
  }

  const worker = await c.env.DB.prepare(
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

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO worker_pins (workerId, pin, updatedAt) VALUES (?, ?, ?)",
  )
    .bind(worker.id, newPin, new Date().toISOString())
    .run();

  // Invalidate any active tokens for this worker — force re-login.
  await c.env.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
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
    await c.env.DB.prepare("DELETE FROM worker_tokens WHERE token = ?")
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
  const row = await c.env.DB.prepare(
    "SELECT * FROM worker_tokens WHERE token = ?",
  )
    .bind(token)
    .first<TokenRow>();
  if (!row) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const worker = await c.env.DB.prepare("SELECT * FROM workers WHERE id = ?")
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
