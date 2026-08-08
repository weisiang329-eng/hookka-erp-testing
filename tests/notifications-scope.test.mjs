// ---------------------------------------------------------------------------
// notifications-scope.test.mjs — /api/notifications must only ever hand a
// caller the rows that caller is allowed to see.
//
// Until 2026-08-08 the GET ran `SELECT * FROM notifications` with no org and
// no user predicate, so every user of every tenant saw every row — and the new
// top-bar bell put that in front of people far more prominently than the
// /notifications page ever did.
//
// The rule under test (behaviour, not shape):
//   visible  ⟺  row.orgId = caller's org  AND  (row.userId IS NULL  OR
//                                               row.userId = caller's user)
// A NULL userId is how "broadcast to everyone in this org" is expressed — a
// broadcast must still reach everybody, so a fix that simply added
// `userId = ?` would have silently emptied the bell.
//
// The route's SQL is executed against a REAL SQL engine (node:sqlite) through
// a thin D1-shaped shim, and the shim camelCases result keys exactly like the
// postgres.js `transform.column.from` in src/api/lib/db-pg.ts does — so a
// snake/camel read bug in the route would fail here too.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";

const { default: notifications } = await import(
  "../src/api/routes/notifications.ts"
);

// snake_case → camelCase, mirroring db-pg.ts's columnFrom for these columns.
const toCamel = (s) => s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

function makeDb(rows) {
  const db = new DatabaseSync(":memory:");
  // Columns named exactly as the route's SQL writes them (the compat layer
  // renames camelCase → snake_case on the way to Postgres; here the route SQL
  // and the table agree directly), plus created_at which the route orders by.
  db.exec(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    type TEXT,
    title TEXT NOT NULL,
    message TEXT,
    severity TEXT,
    isRead INTEGER NOT NULL DEFAULT 0,
    link TEXT,
    created_at TEXT NOT NULL,
    orgId TEXT NOT NULL,
    userId TEXT
  )`);
  const ins = db.prepare(
    `INSERT INTO notifications
       (id, type, title, message, severity, isRead, link, created_at, orgId, userId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    ins.run(
      r.id,
      r.type ?? "SYSTEM",
      r.title ?? r.id,
      r.message ?? null,
      r.severity ?? "info",
      r.isRead ?? 0,
      r.link ?? null,
      r.created_at ?? "2026-08-01T00:00:00Z",
      r.orgId,
      r.userId ?? null,
    );
  }

  const shim = {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...args) {
          bound = args;
          return api;
        },
        async all() {
          const raw = db.prepare(sql).all(...bound);
          return {
            results: raw.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [toCamel(k), v]),
              ),
            ),
            success: true,
          };
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return api;
    },
  };
  return { db, shim };
}

// One org, two users, plus a second tenant.
const ROWS = [
  { id: "b1", orgId: "hookka", userId: null, title: "Broadcast" },
  { id: "u-alice", orgId: "hookka", userId: "alice", title: "For Alice" },
  { id: "u-bob", orgId: "hookka", userId: "bob", title: "For Bob" },
  { id: "other-org", orgId: "acme", userId: null, title: "Acme broadcast" },
  { id: "other-org-user", orgId: "acme", userId: "alice", title: "Acme Alice" },
];

function mount(shim, { orgId, userId }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("DB", shim);
    if (orgId) c.set("orgId", orgId);
    if (userId) c.set("userId", userId);
    c.set("userRole", "ADMIN");
    await next();
  });
  app.route("/api/notifications", notifications);
  return app;
}

async function idsFor(who, query = "") {
  const { shim } = makeDb(ROWS);
  const res = await mount(shim, who).request(
    `/api/notifications${query}`,
  );
  assert.equal(res.status, 200, "the feed must load");
  const body = await res.json();
  return body.map((n) => n.id).sort();
}

test("a user sees org broadcasts plus their OWN rows — nobody else's", async () => {
  assert.deepEqual(await idsFor({ orgId: "hookka", userId: "alice" }), [
    "b1",
    "u-alice",
  ]);
});

test("the other user of the same org sees the broadcast and only THEIR row", async () => {
  assert.deepEqual(await idsFor({ orgId: "hookka", userId: "bob" }), [
    "b1",
    "u-bob",
  ]);
});

test("a second tenant never sees the first tenant's rows", async () => {
  assert.deepEqual(await idsFor({ orgId: "acme", userId: "alice" }), [
    "other-org",
    "other-org-user",
  ]);
});

test("the ?type= filter still narrows, on top of the scope", async () => {
  const { shim } = makeDb([
    ...ROWS,
    { id: "u-alice-stock", orgId: "hookka", userId: "alice", type: "STOCK" },
  ]);
  const res = await mount(shim, {
    orgId: "hookka",
    userId: "alice",
  }).request("/api/notifications?type=STOCK");
  const body = await res.json();
  assert.deepEqual(
    body.map((n) => n.id),
    ["u-alice-stock"],
  );
});

test("marking read cannot touch another user's or another org's row", async () => {
  const { db, shim } = makeDb(ROWS);
  const res = await mount(shim, { orgId: "hookka", userId: "alice" }).request(
    "/api/notifications",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["b1", "u-alice", "u-bob", "other-org"] }),
    },
  );
  assert.equal(res.status, 200);
  const readIds = db
    .prepare("SELECT id FROM notifications WHERE isRead = 1 ORDER BY id")
    .all()
    .map((r) => r.id);
  assert.deepEqual(readIds, ["b1", "u-alice"]);
});

test("an unresolved org fails closed rather than returning everything", async () => {
  const { shim } = makeDb(ROWS);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("DB", shim);
    c.set("userId", "alice");
    c.set("userRole", "ADMIN");
    await next();
  });
  app.route("/api/notifications", notifications);
  const res = await app.request("/api/notifications");
  assert.notEqual(res.status, 200, "no org on the request must not return rows");
});
