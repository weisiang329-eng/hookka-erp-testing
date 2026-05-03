// ---------------------------------------------------------------------------
// Customer Maintenance — per-customer snapshot of the master variants config.
//
// The master Maintenance config (Divan Heights, Total Heights, Gaps, Leg
// Heights, Specials, Sofa Sizes / Leg Heights / Specials, Fabrics) lives in
// kv_config['variants-config']. Each customer can have their own copy of
// this blob keyed as kv_config['variants-config:<customerId>']. Once seeded
// from master, future master changes don't affect that customer.
//
// Storage approach: reuse the existing kv_config table — no schema migration
// needed. Reads/writes go through /api/kv-config/:key with the namespaced
// key. This route only exposes the server-side "copy from master" operation
// so the client doesn't have to round-trip the full blob.
//
// Endpoints:
//   POST /api/customer-maintenance/:customerId/copy-from-master
//     Reads kv_config['variants-config'], writes the SAME value to
//     kv_config['variants-config:<customerId>']. Returns success.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

const MASTER_KEY = "variants-config";
const CUSTOMER_KEY_PREFIX = "variants-config:";

// POST /:customerId/copy-from-master
app.post("/:customerId/copy-from-master", async (c) => {
  // Snapshotting is a write to a customer-scoped config blob. Reuse the same
  // permission gate the underlying kv_config PUT enforces.
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;

  const customerId = c.req.param("customerId").trim();
  if (!customerId) {
    return c.json({ success: false, error: "customerId is required" }, 400);
  }

  // Confirm the customer exists so we don't seed orphan keys.
  const cust = await c.var.DB.prepare(
    "SELECT id FROM customers WHERE id = ?",
  )
    .bind(customerId)
    .first<{ id: string }>();
  if (!cust) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }

  // Read master.
  const masterRow = await c.var.DB.prepare(
    "SELECT value FROM kv_config WHERE key = ?",
  )
    .bind(MASTER_KEY)
    .first<{ value: string }>();
  if (!masterRow) {
    return c.json(
      { success: false, error: "Master variants-config not set yet" },
      404,
    );
  }

  // Validate master payload — we want a valid JSON blob to copy. If master
  // is corrupt, refuse the snapshot rather than propagate garbage.
  try {
    JSON.parse(masterRow.value);
  } catch {
    return c.json(
      { success: false, error: "Master variants-config is malformed JSON" },
      500,
    );
  }

  // Upsert into kv_config under the customer-scoped key. Note: there's an
  // existing typo at routes/kv-config.ts (excluded.updatedAt vs
  // excluded.updated_at) — we use the column name directly here to avoid
  // tripping that bug on conflict.
  const customerKey = `${CUSTOMER_KEY_PREFIX}${customerId}`;
  const now = new Date().toISOString();
  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(customerKey, masterRow.value, now)
    .run();

  return c.json({
    success: true,
    data: {
      customerId,
      key: customerKey,
      copiedAt: now,
    },
  });
});

export default app;
