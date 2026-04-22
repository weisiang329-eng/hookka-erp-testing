// ---------------------------------------------------------------------------
// Edit presence — "who's editing this record right now".
//
// POST   /api/presence              { recordType, recordId } -> upsert heartbeat
// GET    /api/presence?recordType=&recordId=  -> list active holders (others)
// DELETE /api/presence              { recordType, recordId } -> release mine
//
// A holder is considered ACTIVE if heartbeatAt is within the last 60 seconds.
// Clients are expected to heartbeat every 30s while the edit view is mounted
// and DELETE on save / unmount. Stale rows are swept opportunistically — no
// background job required on D1.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

const ACTIVE_WINDOW_MS = 60_000;

type PresenceRow = {
  id: string;
  recordType: string;
  recordId: string;
  userId: string;
  displayName: string;
  acquiredAt: string;
  heartbeatAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cutoffIso(): string {
  return new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
}

function getUserId(c: { get: (k: string) => string | undefined }): string | null {
  const id = c.get("userId");
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function getDisplayName(
  db: D1Database,
  userId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT displayName, email FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ displayName: string | null; email: string | null }>();
  return row?.displayName?.trim() || row?.email || "Someone";
}

// POST /api/presence — upsert my heartbeat for (recordType, recordId)
app.post("/", async (c) => {
  const userId = getUserId(c as unknown as { get: (k: string) => string | undefined });
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  let body: { recordType?: string; recordId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  const recordType = (body.recordType || "").trim();
  const recordId = (body.recordId || "").trim();
  if (!recordType || !recordId) {
    return c.json(
      { success: false, error: "recordType and recordId required" },
      400,
    );
  }

  const now = nowIso();
  const displayName = await getDisplayName(c.env.DB, userId);

  // Opportunistic sweep of ancient stale rows so the table doesn't grow
  // unbounded. Anything older than 5 minutes is definitely abandoned.
  const sweepCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  await c.env.DB.prepare("DELETE FROM edit_presence WHERE heartbeatAt < ?")
    .bind(sweepCutoff)
    .run();

  // Upsert keyed by (recordType, recordId, userId).
  const id = `${recordType}:${recordId}:${userId}`;
  await c.env.DB.prepare(
    `INSERT INTO edit_presence
       (id, recordType, recordId, userId, displayName, acquiredAt, heartbeatAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recordType, recordId, userId)
     DO UPDATE SET heartbeatAt = excluded.heartbeatAt,
                   displayName = excluded.displayName`,
  )
    .bind(id, recordType, recordId, userId, displayName, now, now)
    .run();

  return c.json({ success: true, heartbeatAt: now });
});

// GET /api/presence?recordType=&recordId=
// Returns holders OTHER than the caller that are still within the active
// window. Empty list means "nobody else is here".
app.get("/", async (c) => {
  const userId = getUserId(c as unknown as { get: (k: string) => string | undefined });
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const recordType = c.req.query("recordType") || "";
  const recordId = c.req.query("recordId") || "";
  if (!recordType || !recordId) {
    return c.json({ success: true, data: [] });
  }

  const res = await c.env.DB.prepare(
    `SELECT userId, displayName, acquiredAt, heartbeatAt
       FROM edit_presence
      WHERE recordType = ? AND recordId = ?
        AND userId != ?
        AND heartbeatAt >= ?
      ORDER BY acquiredAt ASC`,
  )
    .bind(recordType, recordId, userId, cutoffIso())
    .all<Omit<PresenceRow, "id" | "recordType" | "recordId">>();

  return c.json({ success: true, data: res.results ?? [] });
});

// DELETE /api/presence — release my hold on a record
app.delete("/", async (c) => {
  const userId = getUserId(c as unknown as { get: (k: string) => string | undefined });
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  let body: { recordType?: string; recordId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  const recordType = (body.recordType || "").trim();
  const recordId = (body.recordId || "").trim();
  if (!recordType || !recordId) {
    return c.json(
      { success: false, error: "recordType and recordId required" },
      400,
    );
  }

  await c.env.DB.prepare(
    "DELETE FROM edit_presence WHERE recordType = ? AND recordId = ? AND userId = ?",
  )
    .bind(recordType, recordId, userId)
    .run();

  return c.json({ success: true });
});

export default app;
