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
import { requirePermission, hasPermission } from "../lib/rbac";

const app = new Hono<Env>();

type Row = {
  key: string;
  value: string;
  updatedAt: string;
};

// GET /api/kv-config/:key
/** Recursively zero any surcharge amount, leaving the option itself intact. */
const PRICE_KEYS = new Set(["priceSen", "surchargeSen", "amountSen", "price", "surcharge"]);

function blankSurcharges(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(blankSurcharges);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = PRICE_KEYS.has(k) && typeof val === "number" ? 0 : blankSurcharges(val);
    }
    return out;
  }
  return v;
}

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

  // `variants-config` carries the option lists AND the surcharge each option
  // adds to the selling price (Products → Maintenance). Owner 2026-08-05: R&D
  // gets the options, not what they add to the price. Blanked to 0 rather than
  // deleted — every form that renders these reads `priceSen` and would show
  // NaN, and an option that silently vanished would look like missing data.
  if (key === "variants-config" && !(await hasPermission(c, "product-pricing", "read"))) {
    parsed = blankSurcharges(parsed);
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
    // `excluded.updated_at` (snake_case) — Postgres exposes the EXCLUDED
    // pseudo-table with the actual column name, and the d1-compat
    // camelCase translator doesn't follow into EXCLUDED.* refs. The old
    // `excluded.updatedAt` exploded with "column does not exist" on every
    // second save (silently — the prepared statement only fails when the
    // ON CONFLICT branch fires), so customer Maintenance / master
    // Maintenance / org letterhead all silently failed to persist edits
    // after the first write. customer-maintenance.ts:81-89 had a
    // workaround comment but the underlying typo was never fixed here.
    `INSERT INTO kv_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();

  return c.json({ success: true, data: body, updatedAt: now });
});

export default app;
