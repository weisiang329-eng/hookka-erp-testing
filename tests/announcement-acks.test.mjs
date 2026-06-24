// ---------------------------------------------------------------------------
// announcement-acks.test.mjs — per-worker read-receipt for office → worker
// announcements (built 2026-06-24). The device-local "Got it" became a real
// server-recorded ack, the office can see who has/hasn't read a notice, and
// "Remind" re-pops it for the un-acked. This suite exercises the route surface
// (src/api/routes/announcements.ts) against a small in-memory DB stub — no
// network, no real Postgres.
//
// Coverage:
//   1. Worker POST /:id/ack writes ONE row (idempotent: a double-tap / retry
//      is ON CONFLICT DO NOTHING, never a second row, never an error).
//   2. Worker POST /:id/ack against a hidden / expired / unknown id writes
//      NOTHING (guards the table from orphan rows; returns acked:false).
//   3. Worker GET / returns this worker's ackedIds for the active notices, and
//      DROPS an id that was reminded AFTER the worker's ack (re-pop semantics).
//   4. Admin GET /:id/acks splits the ACTIVE roster into acked (with time) and
//      pending — the office read-receipt.
//   5. Auth gates: worker endpoints 401 without a token; the admin acks/remind
//      endpoints are permission-gated (deny → 403).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping (Node 22.6+) handles the .ts import without a loader.
}
void loaderRegistered;

// ---- In-memory DB stub -----------------------------------------------------
// Backs the three tables the announcement routes touch:
//   announcements, announcement_acks, workers
// Routes SQL through a pattern-match dispatch table — not a real engine. The
// CREATE TABLE / ALTER / CREATE INDEX DDL from ensureAnnouncementsTable is
// accepted as a no-op so the ensure() resolves cleanly.
function makeDb({ announcements = [], workers = [], acks = [] } = {}) {
  const annTable = new Map(); // id -> row
  const workerTable = new Map(); // id -> row
  const ackTable = new Map(); // `${annId}::${workerId}` -> { announcement_id, worker_id, acked_at }

  for (const a of announcements) annTable.set(a.id, { ...a });
  for (const w of workers) workerTable.set(w.id, { ...w });
  for (const k of acks)
    ackTable.set(`${k.announcement_id}::${k.worker_id}`, { ...k });

  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        // announcement by id (+ org)
        if (/FROM announcements WHERE id = \?/i.test(s)) {
          const row = annTable.get(bound[0]);
          if (!row) return null;
          // org filter when present
          if (/org_id = \?/i.test(s) && row.org_id !== bound[1]) return null;
          return { ...row };
        }
        return null;
      },
      async all() {
        // workers roster: SELECT ... FROM workers WHERE status = 'ACTIVE'
        if (/FROM workers WHERE status = 'ACTIVE'/i.test(s)) {
          const out = [...workerTable.values()].filter(
            (w) => w.status === "ACTIVE",
          );
          return { results: out.map((w) => ({ ...w })) };
        }
        // this worker's acks: WHERE worker_id = ?
        if (/FROM announcement_acks WHERE worker_id = \?/i.test(s)) {
          const wid = bound[0];
          const out = [...ackTable.values()].filter(
            (r) => r.worker_id === wid,
          );
          return { results: out.map((r) => ({ ...r })) };
        }
        // one announcement's acks: WHERE announcement_id = ?
        if (/FROM announcement_acks WHERE announcement_id = \?/i.test(s)) {
          const aid = bound[0];
          const out = [...ackTable.values()].filter(
            (r) => r.announcement_id === aid,
          );
          return { results: out.map((r) => ({ ...r })) };
        }
        // all announcements for org
        if (/FROM announcements WHERE org_id = \?/i.test(s)) {
          const out = [...annTable.values()].filter(
            (r) => r.org_id === bound[0],
          );
          return { results: out.map((r) => ({ ...r })) };
        }
        return { results: [] };
      },
      async run() {
        // ack upsert
        if (/INSERT INTO announcement_acks/i.test(s)) {
          const [announcement_id, worker_id, acked_at] = bound;
          const key = `${announcement_id}::${worker_id}`;
          // ON CONFLICT DO NOTHING — keep the first row's acked_at.
          if (!ackTable.has(key)) {
            ackTable.set(key, { announcement_id, worker_id, acked_at });
          }
          return { success: true };
        }
        // remind: UPDATE announcements SET reminded_at = ?
        if (/UPDATE announcements SET reminded_at = \?/i.test(s)) {
          const [reminded_at, id] = bound;
          const row = annTable.get(id);
          if (row) row.reminded_at = reminded_at;
          return { success: true };
        }
        // delete announcement / its acks
        if (/DELETE FROM announcements WHERE id = \?/i.test(s)) {
          annTable.delete(bound[0]);
          return { success: true };
        }
        if (/DELETE FROM announcement_acks WHERE announcement_id = \?/i.test(s)) {
          const aid = bound[0];
          for (const k of [...ackTable.keys()]) {
            if (ackTable.get(k).announcement_id === aid) ackTable.delete(k);
          }
          return { success: true };
        }
        // All DDL (CREATE TABLE / ALTER / CREATE INDEX) — accept as no-op.
        return { success: true };
      },
    };
    return obj;
  }

  return {
    db: { prepare },
    _state: { annTable, workerTable, ackTable },
  };
}

// ---- Auth + permission stubs ------------------------------------------------
// The worker sub-app resolves the token via worker-auth.resolveWorkerToken
// (SELECT workerId FROM worker_tokens WHERE token = ?). We back that with a
// tiny token map layered onto the DB stub's prepare.
function withTokens(base, tokenMap) {
  const inner = base.db.prepare;
  return {
    ...base,
    db: {
      prepare(sql) {
        if (/FROM worker_tokens WHERE token = \?/i.test(sql.trim())) {
          let bound = [];
          const obj = {
            bind(...args) {
              bound = args;
              return obj;
            },
            async first() {
              const workerId = tokenMap.get(bound[0]);
              return workerId ? { workerId } : null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
          return obj;
        }
        return inner(sql);
      },
    },
  };
}

// Wrap a sub-app with the DB-binding middleware (production worker.ts does the
// same) and, for the admin app, a stubbed permission decision on the context.
function wrapWorker(routeApp, db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

function wrapAdmin(routeApp, db, { role = "SUPER_ADMIN" } = {}) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    // requirePermission reads userRole off the context; SUPER_ADMIN/ADMIN
    // bypass everything in rbac.ts.
    c.set("userRole", role);
    c.set("userId", "user-1");
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

async function call(app, { method, path, body, headers = {}, env = {} }) {
  const init = {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  return app.request(path, init, env);
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function activeAnnouncement(id, extra = {}) {
  return {
    id,
    org_id: "hookka",
    title: `Notice ${id}`,
    body: "",
    is_active: true,
    expires_at: null,
    created_by: null,
    created_at: iso(NOW - 10_000),
    updated_at: null,
    reminded_at: null,
    translations: null,
    ...extra,
  };
}

const WORKERS = [
  { id: "w1", empNo: "E001", name: "Alice", status: "ACTIVE" },
  { id: "w2", empNo: "E002", name: "Bob", status: "ACTIVE" },
  { id: "w3", empNo: "E003", name: "Carol", status: "INACTIVE" }, // not on roster
];

async function importWorkerApp(tag) {
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/routes/announcements.ts"),
    ).href + `?t=${tag}`
  );
  return mod.announcementsWorker;
}
async function importAdminApp(tag) {
  const mod = await import(
    pathToFileURL(
      resolve(process.cwd(), "src/api/routes/announcements.ts"),
    ).href + `?t=${tag}`
  );
  return mod.announcementsAdmin;
}

// ---- 1. Worker ack idempotency ---------------------------------------------

test("worker ack: a double-tap writes exactly one row (idempotent)", async () => {
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
  });
  const withTok = withTokens(base, new Map([["tok-w1", "w1"]]));
  const app = wrapWorker(await importWorkerApp("ack-idem"), withTok.db);

  for (let i = 0; i < 3; i++) {
    const res = await call(app, {
      method: "POST",
      path: "/ann-1/ack",
      headers: { "x-worker-token": "tok-w1" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.acked, true);
  }
  const rows = [...base._state.ackTable.values()].filter(
    (r) => r.announcement_id === "ann-1" && r.worker_id === "w1",
  );
  assert.equal(rows.length, 1, "three taps → one ack row");
});

// ---- 2. Ack against a non-active / unknown id is a no-op -------------------

test("worker ack: hidden / expired / unknown id writes NO row", async () => {
  const base = makeDb({
    announcements: [
      activeAnnouncement("ann-hidden", { is_active: false }),
      activeAnnouncement("ann-expired", { expires_at: iso(NOW - 1000) }),
    ],
    workers: WORKERS,
  });
  const withTok = withTokens(base, new Map([["tok-w1", "w1"]]));
  const app = wrapWorker(await importWorkerApp("ack-guard"), withTok.db);

  for (const id of ["ann-hidden", "ann-expired", "ann-nope"]) {
    const res = await call(app, {
      method: "POST",
      path: `/${id}/ack`,
      headers: { "x-worker-token": "tok-w1" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.acked, false, `${id} should not be ackable`);
  }
  assert.equal(base._state.ackTable.size, 0, "no orphan ack rows written");
});

// ---- 3. Worker GET returns ackedIds + re-pop after remind ------------------

test("worker GET: ackedIds reflects acks, and a remind-since drops the id", async () => {
  const ackedAt = iso(NOW - 5000);
  const base = makeDb({
    announcements: [
      activeAnnouncement("ann-acked"), // acked, never reminded → in ackedIds
      activeAnnouncement("ann-reminded", { reminded_at: iso(NOW - 1000) }), // acked then reminded → NOT in ackedIds
      activeAnnouncement("ann-fresh"), // never acked → not in ackedIds
    ],
    workers: WORKERS,
    acks: [
      { announcement_id: "ann-acked", worker_id: "w1", acked_at: ackedAt },
      { announcement_id: "ann-reminded", worker_id: "w1", acked_at: ackedAt },
    ],
  });
  const withTok = withTokens(base, new Map([["tok-w1", "w1"]]));
  const app = wrapWorker(await importWorkerApp("get-acked"), withTok.db);

  const res = await call(app, {
    method: "GET",
    path: "/",
    headers: { "x-worker-token": "tok-w1" },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.data.length, 3, "all three active notices returned");
  const acked = new Set(json.ackedIds);
  assert.ok(acked.has("ann-acked"), "acked + not reminded → suppressed");
  assert.ok(
    !acked.has("ann-reminded"),
    "reminded after ack → re-pops (excluded from ackedIds)",
  );
  assert.ok(!acked.has("ann-fresh"), "never acked → not in ackedIds");
});

// ---- 4. Admin acks-list split ----------------------------------------------

test("admin GET /:id/acks: splits the active roster into acked + pending", async () => {
  const ackedAt = iso(NOW - 2000);
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
    acks: [
      { announcement_id: "ann-1", worker_id: "w1", acked_at: ackedAt },
    ],
  });
  const app = wrapAdmin(await importAdminApp("admin-acks"), base.db);

  const res = await call(app, { method: "GET", path: "/ann-1/acks" });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  const d = json.data;
  // Only w1 + w2 are ACTIVE (w3 is INACTIVE → off the roster).
  assert.equal(d.total, 2, "roster = active workers only");
  assert.equal(d.ackedCount, 1);
  assert.equal(d.acked.length, 1);
  assert.equal(d.acked[0].id, "w1");
  assert.equal(d.acked[0].name, "Alice");
  assert.equal(d.acked[0].ackedAt, ackedAt);
  assert.equal(d.pending.length, 1);
  assert.equal(d.pending[0].id, "w2");
  // INACTIVE worker never appears on either side.
  const all = [...d.acked, ...d.pending].map((w) => w.id);
  assert.ok(!all.includes("w3"), "inactive worker excluded entirely");
});

// ---- 4b. Admin remind returns the un-acked count + stamps reminded_at ------

test("admin POST /:id/remind: returns the un-acked count and stamps reminded_at", async () => {
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
    acks: [{ announcement_id: "ann-1", worker_id: "w1", acked_at: iso(NOW) }],
  });
  const app = wrapAdmin(await importAdminApp("admin-remind"), base.db);

  const res = await call(app, { method: "POST", path: "/ann-1/remind" });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.pendingCount, 1, "one active worker (w2) hasn't acked");
  assert.ok(
    base._state.annTable.get("ann-1").reminded_at,
    "reminded_at stamped",
  );
});

// ---- 5. Auth gates ----------------------------------------------------------

test("worker ack: missing token → 401 (default-protect)", async () => {
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
  });
  const withTok = withTokens(base, new Map());
  const app = wrapWorker(await importWorkerApp("ack-401"), withTok.db);
  const res = await call(app, { method: "POST", path: "/ann-1/ack" });
  assert.equal(res.status, 401);
  assert.equal(base._state.ackTable.size, 0);
});

test("admin remind: a role without the update permission is denied (403)", async () => {
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
  });
  // A read-only legacy role: rbac grants "*:read" as the fail-safe, so the
  // acks LIST (action=read) is allowed, but REMIND (action=update) is denied.
  // This proves the office mutation is gated, not just open to any caller.
  const app = wrapAdmin(await importAdminApp("admin-403"), base.db, {
    role: "READ_ONLY",
  });
  const acksRes = await call(app, { method: "GET", path: "/ann-1/acks" });
  assert.equal(acksRes.status, 200, "read-only can VIEW the read receipts");
  const remindRes = await call(app, { method: "POST", path: "/ann-1/remind" });
  assert.equal(remindRes.status, 403, "remind (update) is permission-gated");
});

test("admin remind: an unauthenticated request (no role) is rejected (401)", async () => {
  const base = makeDb({
    announcements: [activeAnnouncement("ann-1")],
    workers: WORKERS,
  });
  // No userRole stamped → requirePermission returns 401.
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", base.db);
    await next();
  });
  parent.route("/", await importAdminApp("admin-401"));
  const res = await call(parent, { method: "POST", path: "/ann-1/remind" });
  assert.equal(res.status, 401, "no role → 401");
});
