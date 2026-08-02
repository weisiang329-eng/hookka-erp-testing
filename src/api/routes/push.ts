// ============================================================
// Web Push subscriptions + send — Worker Portal notifications (additive).
//
// Mounted at /api/push (registered BEFORE the dashboard authMiddleware in
// worker.ts, same as the /api/internal/* cron triggers and
// /api/mail-center/inbound). Each handler does its OWN auth so nothing here
// is actually unguarded:
//   POST /api/push/subscribe         — X-Worker-Token (a worker subscribing their own device)
//   POST /api/push/unsubscribe       — X-Worker-Token (or by endpoint)
//   GET  /api/push/vapid-public-key  — public (the key is meant to be public)
//   POST /api/push/clock-reminder    — x-push-secret == env.PUSH_CRON_SECRET (cron only)
//
// Storage: push_subscriptions (migration 0195). Self-applied at runtime before
// the first write (deploys do NOT replay migration files — see CLAUDE.md).
//
// Crypto lives in ../lib/web-push.ts and uses ONLY crypto.subtle + fetch
// (the Node `web-push` package does not run on Workers).
// ============================================================
import { Hono } from "hono";
import type { Env } from "../worker";
import { resolveWorkerToken } from "./worker-auth";
import {
  sendPush,
  type PushPayload,
  type SendResult,
  type VapidConfig,
} from "../lib/web-push";

const app = new Hono<Env>();

// ---- runtime self-apply of the push_subscriptions table ----
// One-shot per isolate; ALTER/CREATE IF NOT EXISTS so a re-run is a no-op.
let _pushMig = false;
async function ensurePushTable(db: D1Database): Promise<void> {
  if (_pushMig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
         id TEXT PRIMARY KEY,
         worker_id TEXT NOT NULL,
         endpoint TEXT NOT NULL UNIQUE,
         p256dh TEXT NOT NULL,
         auth TEXT NOT NULL,
         created_at TEXT
       )`,
    )
    .run();
  // Helpful for targeted sends + pruning by worker.
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_worker ON push_subscriptions(worker_id)",
    )
    .run();
  _pushMig = true;
}

function genId(): string {
  return `push-${crypto.randomUUID().slice(0, 12)}`;
}

// Constant-time string compare for the cron secret (avoids a timing oracle).
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Hash both to fixed length so length never leaks via early return.
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", ab),
    crypto.subtle.digest("SHA-256", bb),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function vapidFromEnv(
  env: Env["Bindings"],
): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT || "mailto:hello@hookka.com",
  };
}

type SubscriptionRow = {
  id: string;
  worker_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

// ============================================================
// GET /api/push/vapid-public-key
// Public read — the client needs the VAPID public key to build a
// PushSubscription. The key is, by design, a public value.
// ============================================================
app.get("/vapid-public-key", (c) => {
  const key = c.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return c.json({ success: false, error: "Push not configured" }, 503);
  }
  return c.json({ success: true, key });
});

// ============================================================
// POST /api/push/subscribe
// Body: { endpoint, keys: { p256dh, auth } }  (the browser PushSubscription JSON)
// Auth: X-Worker-Token. Upsert by endpoint (re-subscribe = update owner/keys).
// ============================================================
app.post("/subscribe", async (c) => {
  const workerId = await resolveWorkerToken(
    c.var.DB,
    c.req.header("x-worker-token"),
  );
  if (!workerId) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  const keys = (body as { keys?: { p256dh?: unknown; auth?: unknown } }).keys;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !endpoint ||
    typeof p256dh !== "string" ||
    !p256dh ||
    typeof auth !== "string" ||
    !auth
  ) {
    return c.json(
      { success: false, error: "endpoint + keys.p256dh + keys.auth required" },
      400,
    );
  }

  await ensurePushTable(c.var.DB);

  // Upsert by endpoint — a device that re-subscribes (or changes owner) updates
  // in place; the UNIQUE(endpoint) constraint backs the ON CONFLICT.
  await c.var.DB.prepare(
    `INSERT INTO push_subscriptions (id, worker_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE
       SET worker_id = EXCLUDED.worker_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth`,
  )
    .bind(genId(), workerId, endpoint, p256dh, auth, new Date().toISOString())
    .run();

  // Lightweight diagnostic — so a "notifications not arriving" report can be
  // traced to whether the subscribe even reached the server. Logs the worker +
  // the push service host only (NEVER the keys/endpoint path, which are secrets).
  let host = "?";
  try {
    host = new URL(endpoint).host;
  } catch {
    /* leave '?' */
  }
  console.log(`[push/subscribe] worker=${workerId} host=${host}`);

  return c.json({ success: true });
});

// ============================================================
// POST /api/push/unsubscribe
// Body: { endpoint }  — Auth: X-Worker-Token. Deletes the row for this device.
// ============================================================
app.post("/unsubscribe", async (c) => {
  const workerId = await resolveWorkerToken(
    c.var.DB,
    c.req.header("x-worker-token"),
  );
  if (!workerId) {
    return c.json({ success: false, error: "Not authenticated" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    return c.json({ success: false, error: "endpoint required" }, 400);
  }
  await ensurePushTable(c.var.DB);
  // Scope the delete to THIS worker so one worker can't unsubscribe another's
  // device by guessing an endpoint.
  await c.var.DB.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ? AND worker_id = ?",
  )
    .bind(endpoint, workerId)
    .run();
  return c.json({ success: true });
});

// ============================================================
// POST /api/push/clock-reminder
// Body: { kind: 'IN' | 'OUT' }  — Auth: x-push-secret == env.PUSH_CRON_SECRET.
// Cron-driven (GitHub Actions); sends a clock-in/out reminder to every
// subscribed worker. Guarded by the shared secret, NOT CSRF (server→server).
// ============================================================
app.post("/clock-reminder", async (c) => {
  const expected = c.env.PUSH_CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[push/clock-reminder] PUSH_CRON_SECRET unset or too short — refusing");
    return c.json({ success: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-push-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ success: false, error: "forbidden" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const kind = (body as { kind?: unknown }).kind === "OUT" ? "OUT" : "IN";

  const payload: PushPayload =
    kind === "OUT"
      ? {
          title: "Clock out reminder",
          body: "End of shift — don't forget to clock out.",
          url: "/worker",
          tag: "clock-reminder",
        }
      : {
          title: "Clock in reminder",
          body: "Good morning! Remember to clock in for today.",
          url: "/worker",
          tag: "clock-reminder",
        };

  const result = await sendPushToSubscribers(c.var.DB, c.env, payload);
  return c.json({ success: true, kind, ...result });
});

// ============================================================
// sendPushToSubscribers — exported helper so OTHER modules (e.g. an
// announcement-post hook, wired by the caller LATER) can fan a notification out
// to subscribed workers. We do NOT modify announcements.ts here — only export.
//
// Targeting:
//   - targetWorkerIds: only these workers' devices.
//   - targetDeptCodes: workers whose home OR multi-dept code is in the set.
//   - neither: ALL subscribed workers.
// Dead subscriptions (404/410 from the push service) are pruned automatically.
// ============================================================
export async function sendPushToSubscribers(
  db: D1Database,
  env: Env["Bindings"],
  opts: {
    title: string;
    body: string;
    url?: string;
    icon?: string;
    badge?: string;
    tag?: string;
    targetWorkerIds?: string[];
    targetDeptCodes?: string[];
  },
): Promise<{ sent: number; failed: number; pruned: number; skipped?: string }> {
  const vapid = vapidFromEnv(env);
  if (!vapid) {
    // Not configured — no-op rather than throw, so callers can fire-and-forget.
    return { sent: 0, failed: 0, pruned: 0, skipped: "vapid-unconfigured" };
  }

  await ensurePushTable(db);

  // Resolve the target worker-id set when departments are specified.
  let workerIdFilter: Set<string> | null = null;
  if (opts.targetWorkerIds && opts.targetWorkerIds.length > 0) {
    workerIdFilter = new Set(opts.targetWorkerIds);
  }
  if (opts.targetDeptCodes && opts.targetDeptCodes.length > 0) {
    const codes = opts.targetDeptCodes.map((d) => d.trim().toUpperCase());
    const ph = codes.map(() => "?").join(",");
    // Match either the primary departmentCode OR any code listed in the
    // departmentCodes JSON array (LIKE on the stringified array — coarse but
    // safe: a false positive just sends one extra reminder).
    const likeClauses = codes.map(() => "departmentCodes LIKE ?").join(" OR ");
    const rows = await db
      .prepare(
        `SELECT id FROM workers WHERE status = 'ACTIVE' AND (departmentCode IN (${ph}) OR ${likeClauses})`,
      )
      .bind(...codes, ...codes.map((c2) => `%"${c2}"%`))
      .all<{ id: string }>();
    const deptWorkerIds = new Set((rows.results ?? []).map((r) => r.id));
    workerIdFilter = workerIdFilter
      ? new Set([...workerIdFilter].filter((id) => deptWorkerIds.has(id)))
      : deptWorkerIds;
  }

  // Load the candidate subscriptions.
  let subs: SubscriptionRow[];
  if (workerIdFilter) {
    const ids = [...workerIdFilter];
    if (ids.length === 0) return { sent: 0, failed: 0, pruned: 0 };
    const ph = ids.map(() => "?").join(",");
    const r = await db
      .prepare(
        `SELECT id, worker_id, endpoint, p256dh, auth FROM push_subscriptions WHERE worker_id IN (${ph})`,
      )
      .bind(...ids)
      .all<SubscriptionRow>();
    subs = r.results ?? [];
  } else {
    const r = await db
      .prepare(
        "SELECT id, worker_id, endpoint, p256dh, auth FROM push_subscriptions",
      )
      .all<SubscriptionRow>();
    subs = r.results ?? [];
  }

  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  const payload: PushPayload = {
    title: opts.title,
    body: opts.body,
    url: opts.url,
    icon: opts.icon,
    badge: opts.badge,
    tag: opts.tag,
  };

  // Fan out. Workers caps subrequests; for a small shop the subscription count
  // is tiny, so a parallel batch is fine.
  const results: SendResult[] = await Promise.all(
    subs.map((s) =>
      sendPush(
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        payload,
        vapid,
      ),
    ),
  );

  let sent = 0;
  let failed = 0;
  const deadEndpoints: string[] = [];
  for (const r of results) {
    if (r.ok) sent++;
    else failed++;
    if (r.gone) deadEndpoints.push(r.endpoint);
  }

  // Prune dead subscriptions (404/410) so the table doesn't accumulate cruft.
  let pruned = 0;
  if (deadEndpoints.length > 0) {
    const ph = deadEndpoints.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM push_subscriptions WHERE endpoint IN (${ph})`)
      .bind(...deadEndpoints)
      .run();
    pruned = deadEndpoints.length;
  }

  // Diagnostic — make a failed fan-out observable in the Worker logs (counts
  // only; no endpoints/keys). A run with sent=0 failed>0 points at VAPID/key
  // mismatch; pruned>0 just means stale devices were cleaned up.
  console.log(
    `[push/send] candidates=${subs.length} sent=${sent} failed=${failed} pruned=${pruned}`,
  );

  return { sent, failed, pruned };
}

export default app;
