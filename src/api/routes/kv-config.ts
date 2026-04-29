// ---------------------------------------------------------------------------
// D1-backed generic key/value config store.
//
// Backs the last remaining business-data localStorage keys that weren't worth
// their own relational table (small settings blobs read/written as whole
// JSON).
//
//   GET /api/kv-config/:key  -> { success, data: <parsed JSON> | null }
//   PUT /api/kv-config/:key  -> upsert, body is the raw JSON payload
//
// Values are stored stringified in TEXT so the UI can round-trip any shape.
// Today only "variants-config" is persisted here.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type Row = {
  key: string;
  value: string;
  updatedAt: string;
};

// GET /api/kv-config/:key
app.get("/:key", async (c) => {
  const key = c.req.param("key");
  const row = await c.var.DB.prepare(
    "SELECT key, value, updated_at FROM kv_config WHERE key = ?",
  )
    .bind(key)
    .first<Row>();

  if (!row) {
    return c.json({ success: true, data: null });
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Malformed row — treat as missing so the UI falls back to defaults
    // rather than crashing on JSON.parse.
    return c.json({ success: true, data: null });
  }

  return c.json({
    success: true,
    data: parsed,
    updatedAt: row.updatedAt,
  });
});

// PUT /api/kv-config/:key  — upsert
app.put("/:key", async (c) => {
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  const key = c.req.param("key");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }

  // Stringify deterministically — the client sends the full blob each time.
  const value = JSON.stringify(body);
  const now = new Date().toISOString();

  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updatedAt`,
  )
    .bind(key, value, now)
    .run();

  return c.json({ success: true, data: body, updatedAt: now });
});

export default app;
