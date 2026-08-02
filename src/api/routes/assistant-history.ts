// ---------------------------------------------------------------------------
// assistant-history.ts — Hookka AI conversation history (per-user, 30-day).
//
// Owner ask (2026-07-13): give Hookka AI a history section like Claude's —
// past conversations you can reopen, pin, rename, delete. Rules he set:
//   • keep the LAST 30 DAYS only (older rows pruned on read);
//   • each account sees ONLY its own conversations (every query is scoped to
//     the authenticated userId — no cross-user visibility).
//
// Persistence is client-driven: after each completed turn the panel PUTs the
// trimmed message list here (no surgery on the delicate SSE stream). One row
// per conversation with the messages stored as a JSON blob (small; attachment
// base64 / blob preview URLs are stripped client-side before saving).
//
// Mounted at /api/assistant/conversations. All columns snake_case; runtime
// self-apply (migration files alone are inert); reads dual-keyed.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

const RETENTION_DAYS = 30;
const MAX_MESSAGES = 200; // cap stored turns so a runaway convo can't bloat
const MAX_BLOB_BYTES = 400_000;

function userIdOf(c: { get: (k: string) => unknown }): string | null {
  const v = (c as unknown as { get: (k: string) => string | undefined }).get("userId");
  return v ?? null;
}

function cutoffIso(): string {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

let _mig = false;
async function ensureTable(db: Env["Variables"]["DB"]): Promise<void> {
  if (_mig) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS assistant_conversations (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         title TEXT,
         pinned INTEGER NOT NULL DEFAULT 0,
         messages TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    )
    .run();
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS idx_assistant_convos_user ON assistant_conversations(user_id, updated_at DESC)",
    )
    .run();
  _mig = true;
}

interface Row {
  id: string;
  user_id?: string;
  userId?: string;
  title?: string | null;
  pinned?: number | string | null;
  messages?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
}

// Best-effort prune of this user's rows older than the retention window.
async function pruneOld(db: Env["Variables"]["DB"], userId: string): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM assistant_conversations WHERE user_id = ? AND updated_at < ?")
      .bind(userId, cutoffIso())
      .run();
  } catch {
    /* best-effort */
  }
}

// ── List (metadata only; last 30 days; pinned first) ─────────────────────────
app.get("/", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ success: false, error: "unauthenticated" }, 401);
  const db = c.var.DB;
  await ensureTable(db);
  await pruneOld(db, userId);
  const res = await db
    .prepare(
      `SELECT id, title, pinned, updated_at FROM assistant_conversations
        WHERE user_id = ? AND updated_at >= ?
        ORDER BY pinned DESC, updated_at DESC
        LIMIT 200`,
    )
    .bind(userId, cutoffIso())
    .all<Row>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    title: r.title ?? "New chat",
    pinned: Number(r.pinned) === 1,
    updatedAt: (r.updatedAt ?? r.updated_at) ?? null,
  }));
  return c.json({ success: true, data });
});

// ── Load one (full messages; owner only) ─────────────────────────────────────
app.get("/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ success: false, error: "unauthenticated" }, 401);
  const db = c.var.DB;
  await ensureTable(db);
  const row = await db
    .prepare("SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<Row>();
  if (!row) return c.json({ success: false, error: "not found" }, 404);
  let messages: unknown[] = [];
  try {
    messages = row.messages ? (JSON.parse(row.messages) as unknown[]) : [];
  } catch {
    messages = [];
  }
  return c.json({
    success: true,
    data: {
      id: row.id,
      title: row.title ?? "New chat",
      pinned: Number(row.pinned) === 1,
      messages,
    },
  });
});

// ── Upsert (save the conversation after a turn; owner-scoped) ─────────────────
app.put("/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ success: false, error: "unauthenticated" }, 401);
  const id = c.req.param("id");
  let body: { messages?: unknown; title?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "bad body" }, 400);
  }
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  let blob = JSON.stringify(msgs);
  if (blob.length > MAX_BLOB_BYTES) {
    // Trim from the front until it fits (keep the most recent turns).
    let trimmed = msgs;
    while (trimmed.length > 1 && JSON.stringify(trimmed).length > MAX_BLOB_BYTES) {
      trimmed = trimmed.slice(1);
    }
    blob = JSON.stringify(trimmed);
  }
  // Title: prefer an explicit one, else the first user text, else "New chat".
  let title = typeof body.title === "string" ? body.title.slice(0, 80) : "";
  if (!title) {
    const firstUser = msgs.find(
      (m): m is { role: string; blocks: Array<{ type: string; text?: string }> } =>
        typeof m === "object" &&
        m !== null &&
        (m as { role?: string }).role === "user",
    );
    const text = firstUser?.blocks?.find((b) => b.type === "text")?.text ?? "";
    title = text.trim().slice(0, 80) || "New chat";
  }
  const db = c.var.DB;
  await ensureTable(db);
  const nowIso = new Date().toISOString();
  // Owner-scoped upsert: the WHERE on user_id in the UPDATE branch stops one
  // user from overwriting another's row even on a guessed id.
  const existing = await db
    .prepare("SELECT id, user_id, created_at FROM assistant_conversations WHERE id = ?")
    .bind(id)
    .first<Row>();
  if (existing && (existing.userId ?? existing.user_id) !== userId) {
    return c.json({ success: false, error: "forbidden" }, 403);
  }
  if (existing) {
    await db
      .prepare(
        "UPDATE assistant_conversations SET title = ?, messages = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .bind(title, blob, nowIso, id, userId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO assistant_conversations (id, user_id, title, pinned, messages, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(id, userId, title, blob, nowIso, nowIso)
      .run();
  }
  return c.json({ success: true, data: { id, title } });
});

// ── Rename / pin (owner-scoped) ──────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ success: false, error: "unauthenticated" }, 401);
  let body: { title?: unknown; pinned?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const db = c.var.DB;
  await ensureTable(db);
  const row = await db
    .prepare("SELECT * FROM assistant_conversations WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<Row>();
  if (!row) return c.json({ success: false, error: "not found" }, 404);
  const title =
    typeof body.title === "string" ? body.title.slice(0, 80) : (row.title ?? "New chat");
  const pinned =
    typeof body.pinned === "boolean" ? (body.pinned ? 1 : 0) : Number(row.pinned) === 1 ? 1 : 0;
  await db
    .prepare(
      "UPDATE assistant_conversations SET title = ?, pinned = ? WHERE id = ? AND user_id = ?",
    )
    .bind(title, pinned, c.req.param("id"), userId)
    .run();
  return c.json({ success: true, data: { title, pinned: pinned === 1 } });
});

// ── Delete (owner-scoped) ────────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ success: false, error: "unauthenticated" }, 401);
  const db = c.var.DB;
  await ensureTable(db);
  await db
    .prepare("DELETE FROM assistant_conversations WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .run();
  return c.json({ success: true });
});

export default app;
