// ---------------------------------------------------------------------------
// D1-backed notifications route.
//
// Mirrors the old src/api/routes/notifications.ts response shape: a plain
// JSON array (not wrapped in {success,data}) so the existing UI code that
// iterates the response doesn't break.
//
// Notifications with userId = NULL are broadcast (visible to every user);
// rows with a userId are scoped to that user only. The current UI has no
// userId concept yet, so the GET returns every row.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string | null;
  severity: string;
  isRead: number;
  link: string | null;
  created_at: string;
};

function rowToNotification(r: NotificationRow) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message ?? "",
    severity: r.severity,
    isRead: r.isRead === 1,
    link: r.link ?? undefined,
    createdAt: r.created_at,
  };
}

// GET /api/notifications?type=...&isRead=true
app.get("/", async (c) => {
  const type = c.req.query("type");
  const isRead = c.req.query("isRead");

  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (type) {
    where.push("type = ?");
    binds.push(type);
  }
  if (isRead !== undefined && isRead !== null && isRead !== "") {
    where.push("isRead = ?");
    binds.push(isRead === "true" ? 1 : 0);
  }
  const sql =
    "SELECT * FROM notifications" +
    (where.length > 0 ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY created_at DESC";
  const res = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<NotificationRow>();
  return c.json((res.results ?? []).map(rowToNotification));
});

// PUT /api/notifications — mark ids as read
app.put("/", async (c) => {
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

  // D1 needs the IN-list expanded.
  const placeholders = ids.map(() => "?").join(", ");
  const res = await c.env.DB.prepare(
    `UPDATE notifications SET isRead = 1 WHERE id IN (${placeholders})`,
  )
    .bind(...(ids as string[]))
    .run();

  const updated = res.meta?.changes ?? 0;
  return c.json({ updated });
});

export default app;
