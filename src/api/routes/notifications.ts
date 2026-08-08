// ---------------------------------------------------------------------------
// D1-backed notifications route.
//
// Mirrors the old src/api/routes/notifications.ts response shape: a plain
// JSON array (not wrapped in {success,data}) so the existing UI code that
// iterates the response doesn't break.
//
// Visibility rule (the ONE definition — both handlers use it):
//   a row is visible to a request iff it is in the caller's org AND it is
//   either a BROADCAST (userId IS NULL — meant for everyone in that org) or
//   addressed to the caller (userId = the authenticated user).
// Broadcast is expressed by the NULL, not by leaving the route open; before
// 2026-08-08 the GET returned every row of every org and every user, which
// the new top-bar bell put in front of everyone.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { withOrgScope } from "../lib/tenant";

const app = new Hono<Env>();

function currentUserId(c: { get: (k: string) => unknown }): string | null {
  const v = (c as unknown as { get: (k: string) => string | undefined }).get(
    "userId",
  );
  return typeof v === "string" && v.length > 0 ? (v as string) : null;
}

/**
 * The per-user half of the visibility rule, as a SQL fragment + its binds.
 * With no resolved user the caller can only ever see broadcasts — never
 * somebody else's addressed row.
 */
function userScope(userId: string | null): { sql: string; binds: string[] } {
  return userId
    ? { sql: "(userId IS NULL OR userId = ?)", binds: [userId] }
    : { sql: "userId IS NULL", binds: [] };
}


type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string | null;
  severity: string;
  // Stored as an integer in the SQLite schema, but a Postgres column typed
  // BOOLEAN comes back as `true`/`false`. Read both — a strict `=== 1` here
  // reports EVERY row unread on a boolean column, which is what keeps the
  // top-bar bell permanently lit while meaning nothing.
  isRead: number | boolean | string | null;
  link: string | null;
  createdAt: string;
};

function rowToNotification(r: NotificationRow) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message ?? "",
    severity: r.severity,
    isRead: r.isRead === 1 || r.isRead === true || r.isRead === "1" || r.isRead === "t",
    link: r.link ?? undefined,
    createdAt: r.createdAt,
  };
}

// GET /api/notifications?type=...&isRead=true
app.get("/", async (c) => {
  const type = c.req.query("type");
  const isRead = c.req.query("isRead");

  // Order matters: the predicates below are joined in this order, so the
  // binds must be pushed in the same order (after withOrgScope's orgId).
  const user = userScope(currentUserId(c));
  const where: string[] = [user.sql];
  const binds: (string | number)[] = [...user.binds];
  if (type) {
    where.push("type = ?");
    binds.push(type);
  }
  if (isRead !== undefined && isRead !== null && isRead !== "") {
    where.push("isRead = ?");
    binds.push(isRead === "true" ? 1 : 0);
  }
  const { whereSql, params } = withOrgScope(
    c,
    "notifications",
    where.join(" AND "),
  );
  const sql = `SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC`;
  const res = await c.var.DB.prepare(sql)
    .bind(...params, ...binds)
    .all<NotificationRow>();
  return c.json((res.results ?? []).map(rowToNotification));
});

// PUT /api/notifications — mark ids as read
app.put("/", async (c) => {
  const denied = await requirePermission(c, "notifications", "update");
  if (denied) return denied;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const ids = (body as { ids?: unknown }).ids;
  if (!ids || !Array.isArray(ids)) {
    return c.json({ error: "ids must be an array of notification IDs" }, 400);
  }
  if (ids.length === 0) return c.json({ updated: 0 });

  // D1 needs the IN-list expanded. Same visibility rule as the GET — an id
  // you cannot see is an id you cannot mark read.
  const placeholders = ids.map(() => "?").join(", ");
  const user = userScope(currentUserId(c));
  const { whereSql, params } = withOrgScope(
    c,
    "notifications",
    `id IN (${placeholders}) AND ${user.sql}`,
  );
  const res = await c.var.DB.prepare(
    `UPDATE notifications SET isRead = 1 ${whereSql}`,
  )
    .bind(...params, ...(ids as string[]), ...user.binds)
    .run();

  const updated = res.meta?.changes ?? 0;
  return c.json({ updated });
});

export default app;
