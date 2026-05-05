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

  // Mirror EVERY master maintenance_config_history snapshot into the
  // customer scope so the customer-side per-item history dialog shows
  // the same timeline as the products side. Without this, the customer
  // scope has zero history rows and the dialog displays only the
  // synthesized "Auto-baseline from kv_config" stub. Idempotent:
  // skip rows that already exist for this customer scope at the same
  // (effective_from, config) pair.
  const customerScope = `customer:${customerId}`;
  // D1 adapter sometimes lowercases mixed-case aliases on the way out.
  // Read with the camelCase alias AND fallback to the lowercased form.
  const masterHistRes = await c.var.DB
    .prepare(
      `SELECT effective_from AS "effectiveFrom", config, notes
         FROM maintenance_config_history
        WHERE scope = 'master'`,
    )
    .all<Record<string, unknown>>();
  const readEff = (r: Record<string, unknown>): string => {
    if (typeof r.effectiveFrom === "string") return r.effectiveFrom;
    if (typeof r.effective_from === "string") return r.effective_from;
    if (typeof (r as Record<string, unknown>)["effectivefrom"] === "string") {
      return (r as Record<string, string>).effectivefrom;
    }
    return "";
  };
  const masterHistRows = (masterHistRes.results ?? [])
    .map((r) => ({
      effective_from: readEff(r),
      config: typeof r.config === "string" ? r.config : "",
      notes: typeof r.notes === "string" ? r.notes : null,
    }))
    .filter((r) => r.effective_from && r.config);
  let mirroredHistoryRows = 0;
  if (masterHistRows.length > 0) {
    const existingCustHistRes = await c.var.DB
      .prepare(
        `SELECT effective_from AS "effectiveFrom", config
           FROM maintenance_config_history
          WHERE scope = ?`,
      )
      .bind(customerScope)
      .all<Record<string, unknown>>();
    const existingCustHistRows = (existingCustHistRes.results ?? [])
      .map((r) => ({
        effective_from: readEff(r),
        config: typeof r.config === "string" ? r.config : "",
      }));
    const existingKeys = new Set(
      existingCustHistRows.map(
        (r) => `${r.effective_from}|${r.config.length}|${r.config.slice(0, 64)}`,
      ),
    );
    const insertStmts = [];
    for (const row of masterHistRows) {
      const key = `${row.effective_from}|${row.config.length}|${row.config.slice(0, 64)}`;
      if (existingKeys.has(key)) continue;
      const newId = `mch-mirror-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      insertStmts.push(
        c.var.DB
          .prepare(
            `INSERT INTO maintenance_config_history
               (id, scope, config, effective_from, notes, created_by)
             VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT (id) DO NOTHING`,
          )
          .bind(
            newId,
            customerScope,
            row.config,
            row.effective_from,
            row.notes
              ? `Mirrored from Master: ${row.notes}`
              : `Mirrored from Master snapshot ${row.effective_from}`,
          ),
      );
      existingKeys.add(key);
      mirroredHistoryRows += 1;
    }
    for (let i = 0; i < insertStmts.length; i += 50) {
      await c.var.DB.batch(insertStmts.slice(i, i + 50));
    }
  }

  return c.json({
    success: true,
    data: {
      customerId,
      key: customerKey,
      copiedAt: now,
      mirroredHistoryRows,
    },
  });
});

export default app;
