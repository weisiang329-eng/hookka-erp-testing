// ---------------------------------------------------------------------------
// org-reporting-wiring.test.mjs
//
// Owner 2026-08-02: 「无论是有新添加的人或者部门，我只要能把 reporting line 放对，
// 这整个东西就会做出来了包括我 edit、通知 reporting line 等等」.
//
// The promise is that adding a person or a department needs NO code change —
// set the manager and everything downstream works. Two things had to be true
// for that and only one was: the chart drew the line, but nothing read it.
// `org_reporting` was referenced by exactly one file, and the notifications
// table had no user_id column at all, so "notify their manager" had nowhere to
// deliver to.
//
// These pin the wiring, not the drawing.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import */
}

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const { managerChainOf, personKey } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/org-people.ts")).href
);

const chainOf = (pairs, who, depth) =>
  managerChainOf(who, new Map(pairs), depth);

test("the chain runs manager, then theirs, nearest first", () => {
  const pairs = [
    ["worker:w1", "worker:lead"],
    ["worker:lead", "user:mgr"],
    ["user:mgr", "user:gm"],
    ["user:gm", null],
  ];
  assert.deepEqual(chainOf(pairs, "worker:w1"), [
    "worker:lead",
    "user:mgr",
    "user:gm",
  ]);
});

test("somebody at the top has an empty chain, not a crash", () => {
  assert.deepEqual(chainOf([["user:gm", null]], "user:gm"), []);
  // Someone with no row at all — a person added a minute ago.
  assert.deepEqual(chainOf([], "worker:brand-new"), []);
});

test("a cycle stops at the repeat instead of spinning", () => {
  // The write path refuses cycles, but one could predate that guard. The walk
  // must terminate, and must never put the person in their own chain.
  const pairs = [
    ["user:a", "user:b"],
    ["user:b", "user:c"],
    ["user:c", "user:a"],
  ];
  const chain = chainOf(pairs, "user:a");
  assert.ok(chain.length <= 3, `chain did not terminate: ${chain.length}`);
  assert.ok(!chain.includes("user:a"), "a person must not report to themselves");
});

test("maxDepth bounds the walk", () => {
  const pairs = Array.from({ length: 50 }, (_, i) => [
    `user:${i}`,
    `user:${i + 1}`,
  ]);
  assert.equal(chainOf(pairs, "user:0").length, 10); // default
  assert.equal(chainOf(pairs, "user:0", 3).length, 3);
});

test("personKey is what links the two people tables", () => {
  // Workers have no account and users have no emp no; the composite key is the
  // only thing an edge between them can hang off.
  assert.equal(personKey("worker", "worker-b311d39e"), "worker:worker-b311d39e");
  assert.equal(personKey("user", 42), "user:42");
});

// --- the delivery side ------------------------------------------------------

const NOTIFY = read("src/api/lib/org-notify.ts");

test("the notifications table gets user_id at RUNTIME, not via a migration", () => {
  // Migrations are inert on deploy in this repo — a column reaches production
  // ONLY through an awaited ALTER on the write path. Without this every
  // targeted notification would throw on a missing column and, being
  // best-effort, vanish silently: the worst failure for a feature whose whole
  // job is to tell someone.
  assert.match(
    NOTIFY,
    /ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id/,
    "no runtime self-apply for user_id",
  );
  assert.match(NOTIFY, /await ensureNotificationTargeting\(db\)/);
});

test("an account-less manager is skipped but does NOT stop the escalation", () => {
  // An Operator Leader has no login. If the walk stopped there, a worker's
  // escalation would reach nobody. It must continue to whoever is above.
  assert.match(
    NOTIFY,
    /if \(parsed\.source !== "user"\) \{[\s\S]{0,120}skipped\.push\(key\);[\s\S]{0,60}continue;/,
    "a worker in the chain must be skipped with `continue`, not `break`",
  );
  // And the depth cut must be applied to REACHABLE managers, not to the raw
  // chain — otherwise depth 1 silently drops the message.
  assert.match(NOTIFY, /targets\.push\(parsed\.id\);[\s\S]{0,80}targets\.length >= depth/);
});

test("a failed notification never fails the thing that triggered it", () => {
  assert.match(NOTIFY, /catch \(e\) \{[\s\S]{0,200}console\.error\("\[org-notify\]/);
  // ...but it is logged. Silent best-effort is how a dead feature stays dead.
});

test("one loader for the edges, so the chart and the message agree", () => {
  // org_reporting wins, users.reportsTo is the legacy fallback — the exact
  // precedence the chart itself uses. Two loaders would drift.
  assert.match(NOTIFY, /SELECT id, reportsTo FROM users/);
  assert.match(NOTIFY, /SELECT person_key, manager_key FROM org_reporting/);
  const u = NOTIFY.indexOf("SELECT id, reportsTo FROM users");
  const e = NOTIFY.indexOf("SELECT person_key, manager_key FROM org_reporting");
  assert.ok(u < e, "org_reporting must be applied AFTER the users fallback, to win");
});

test("setting a reporting line actually notifies the new manager", () => {
  const route = read("src/api/routes/org-chart.ts");
  assert.match(route, /notifyManagerChain\(/, "the PUT must use the wiring it writes");
  // After the write: the line is saved whether or not the message lands.
  const write = route.indexOf("INSERT INTO org_reporting");
  const notify = route.indexOf("notifyManagerChain(\n");
  assert.ok(write < notify, "notify must come after the write, not before it");
});

test("a targeted notification reaches its person and nobody else", () => {
  const route = read("src/api/routes/notifications.ts");
  assert.match(
    route,
    /where\.push\("\(userId IS NULL OR userId = \?\)"\)/,
    "the list must be scoped to the caller plus broadcasts",
  );
  // No session (service token) → broadcasts only. Showing everyone's targeted
  // mail would be worse than showing less.
  assert.match(route, /where\.push\("userId IS NULL"\)/);
});

test("a new department needs no code — the chart reads the real table", () => {
  const api = read("src/api/routes/org-chart.ts");
  assert.match(api, /SELECT code, name, sequence FROM departments/);
  const ui = read("src/components/org-chart.tsx");
  assert.match(ui, /departments\?: DeptMeta\[\]/, "the chart must consume the list");
  assert.ok(
    !/const DEPT_ORDER = \[/.test(ui),
    "the hardcoded department order must be a fallback, not the source of truth",
  );
  assert.match(ui, /DEPT_ORDER_FALLBACK/);
});
