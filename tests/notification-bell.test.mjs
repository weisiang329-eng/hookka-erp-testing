// ---------------------------------------------------------------------------
// notification-bell.test.mjs — the top-bar bell must reflect REAL unread state.
//
// It used to be a <button> with no onClick and a hardcoded pink dot: unclickable
// and permanently "unread". These pin the behaviour that replaced it —
//   • the dot is derived from the rows, and vanishes at zero unread;
//   • the popover shows unread first, newest first, capped;
//   • marking read broadcasts so the OTHER surface (/notifications) agrees;
//   • the API's isRead read survives an integer OR a boolean column.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const feed = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/notifications-feed.ts")).href
);

const n = (id, isRead, createdAt, extra = {}) => ({
  id,
  type: "SYSTEM",
  title: `t-${id}`,
  message: "m",
  severity: "INFO",
  isRead,
  createdAt,
  ...extra,
});

// ── Unread count drives the dot ────────────────────────────────────────────

test("unreadCount counts only genuinely-unread rows", () => {
  const list = [
    n("a", false, "2026-08-08T10:00:00Z"),
    n("b", true, "2026-08-08T09:00:00Z"),
    n("c", false, "2026-08-08T08:00:00Z"),
  ];
  assert.equal(feed.unreadCount(list), 2);
});

test("everything read → count is 0, so the dot must not render", () => {
  const list = [n("a", true, "2026-08-08T10:00:00Z"), n("b", true, "2026-08-08T09:00:00Z")];
  assert.equal(feed.unreadCount(list), 0);
});

test("an empty feed is 0 unread, not a lit dot", () => {
  assert.equal(feed.unreadCount([]), 0);
});

test("a legacy integer/string read flag still counts as READ", () => {
  // A row that came back as 1 / "1" is read. Treating it as unread is exactly
  // how a permanently-lit indicator happens.
  assert.equal(feed.unreadCount([n("a", 1, "2026-08-08T10:00:00Z")]), 0);
  assert.equal(feed.unreadCount([n("a", "1", "2026-08-08T10:00:00Z")]), 0);
  assert.equal(feed.unreadCount([n("a", 0, "2026-08-08T10:00:00Z")]), 1);
});

// ── Payload shapes ─────────────────────────────────────────────────────────

test("parseNotificationList accepts a bare array and a {data} envelope", () => {
  const rows = [n("a", false, "2026-08-08T10:00:00Z")];
  assert.equal(feed.parseNotificationList(rows).length, 1);
  assert.equal(feed.parseNotificationList({ data: rows }).length, 1);
});

test("a junk payload yields an empty feed rather than throwing the top bar down", () => {
  assert.deepEqual(feed.parseNotificationList(null), []);
  assert.deepEqual(feed.parseNotificationList("nope"), []);
  assert.deepEqual(feed.parseNotificationList({ error: "boom" }), []);
});

// ── Popover ordering ───────────────────────────────────────────────────────

test("recentForBell puts unread first, each group newest-first", () => {
  const list = [
    n("old-read", true, "2026-08-01T10:00:00Z"),
    n("new-read", true, "2026-08-08T10:00:00Z"),
    n("old-unread", false, "2026-08-02T10:00:00Z"),
    n("new-unread", false, "2026-08-07T10:00:00Z"),
  ];
  assert.deepEqual(
    feed.recentForBell(list).map((x) => x.id),
    ["new-unread", "old-unread", "new-read", "old-read"],
  );
});

test("recentForBell caps the popover", () => {
  const list = Array.from({ length: 25 }, (_, i) =>
    n(`x${i}`, false, `2026-08-0${(i % 9) + 1}T10:00:00Z`),
  );
  assert.equal(feed.recentForBell(list).length, 8);
  assert.equal(feed.recentForBell(list, 3).length, 3);
});

// ── Cross-surface broadcast ────────────────────────────────────────────────

test("marking read broadcasts so the other surface re-reads", async () => {
  const origFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ updated: sent.ids.length }) };
  };
  let fired = 0;
  const unsub = feed.subscribeNotifications(() => { fired += 1; });
  try {
    const ok = await feed.markNotificationsRead(["a", "b"]);
    assert.equal(ok, true);
    assert.deepEqual(sent, { ids: ["a", "b"] });
    assert.equal(fired, 1, "subscribers must be told the feed changed");
  } finally {
    unsub();
    globalThis.fetch = origFetch;
  }
});

test("a REJECTED mark-read does not broadcast a change that didn't happen", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  let fired = 0;
  const unsub = feed.subscribeNotifications(() => { fired += 1; });
  try {
    assert.equal(await feed.markNotificationsRead(["a"]), false);
    assert.equal(fired, 0);
  } finally {
    unsub();
    globalThis.fetch = origFetch;
  }
});

test("marking an empty id list is a no-op, not a request", async () => {
  const origFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return { ok: true, json: async () => ({}) }; };
  try {
    assert.equal(await feed.markNotificationsRead([]), true);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("a network failure leaves the feed empty rather than crashing the bell", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    assert.deepEqual(await feed.loadNotifications(), []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Wiring (source assertions) ─────────────────────────────────────────────

test("topbar mounts the real bell — no dead button, no hardcoded dot", () => {
  const src = readFileSync("src/components/layout/topbar.tsx", "utf8");
  assert.match(src, /<NotificationBell \/>/, "topbar must render NotificationBell");
  assert.doesNotMatch(
    src,
    /absolute right-1 top-1 h-2 w-2 rounded-full bg-\[#EC4899\]/,
    "the hardcoded always-on unread dot must be gone",
  );
});

test("the bell renders its dot ONLY when unread > 0, and can be opened", () => {
  const src = readFileSync("src/components/layout/notification-bell.tsx", "utf8");
  assert.match(src, /unread > 0 && \(/, "dot must be gated on a real unread count");
  assert.match(src, /onClick=\{\(\) => \{/, "the bell must be clickable");
  assert.match(src, /navigate\("\/notifications"\)/, "popover must reach the full page");
});

test("the notifications page marks read through the shared feed helper", () => {
  const src = readFileSync("src/pages/notifications.tsx", "utf8");
  assert.match(src, /markNotificationsRead\(ids\)/);
  assert.doesNotMatch(
    src,
    /fetch\("\/api\/notifications",\s*\{\s*method: "PUT"/,
    "the page must not PUT behind the shared helper's back — the bell would go stale",
  );
});

test("the API reads isRead from an integer OR a boolean column", () => {
  const src = readFileSync("src/api/routes/notifications.ts", "utf8");
  assert.match(src, /r\.isRead === true/, "a BOOLEAN column must not read as unread");
});
