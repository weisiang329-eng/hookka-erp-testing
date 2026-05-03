// ---------------------------------------------------------------------------
// Maintenance config history — effective-dated wrapper over the maintenance
// config blob (Bedframe Divan/Total/Gap/Leg/Specials, Sofa Sizes/Leg/
// Specials, Common Fabrics).
//
// Each row stores the FULL config JSON for a given scope at an effective
// date. Resolver picks newest WHERE effective_from <= today. Append-only —
// edits are new rows, not in-place updates.
//
// Endpoints:
//   GET    /api/maintenance-config/resolved?scope=master|customer:<id>
//          → resolved current config for today (parsed JSON)
//   GET    /api/maintenance-config/history?scope=...
//          → full history (past + pending) ordered effectiveFrom DESC
//   POST   /api/maintenance-config/changes
//          → append a new effective-dated row
//          body: { scope, config, effectiveFrom, notes? }
//   DELETE /api/maintenance-config/changes/:id
//          → remove a row (e.g., cancel a pending future)
//
// scope conventions (string):
//   'master'                — company-wide master config
//   'customer:<customerId>' — per-customer override
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type Row = {
  id: string;
  scope: string;
  config: string;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function genId(): string {
  // 12 hex chars after the prefix — collision-resistant for this volume.
  const rnd = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `mch-${rnd}`;
}

function parseScope(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (s === "master") return "master";
  if (s.startsWith("customer:")) {
    const id = s.slice("customer:".length).trim();
    if (!id) return null;
    return `customer:${id}`;
  }
  return null;
}

// GET /api/maintenance-config/resolved?scope=...
app.get("/resolved", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  if (!scope) {
    return c.json({ success: false, error: "scope is required" }, 400);
  }
  const today = todayIso();
  const row = await c.var.DB.prepare(
    `SELECT id, scope, config, effectiveFrom, notes, createdAt, createdBy
       FROM maintenance_config_history
      WHERE scope = ? AND effectiveFrom <= ?
      ORDER BY effectiveFrom DESC, createdAt DESC
      LIMIT 1`,
  )
    .bind(scope, today)
    .first<Row>();
  if (!row) return c.json({ success: true, data: null });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    return c.json({ success: true, data: null });
  }
  // Surface a pending-future flag so the UI can warn the operator that a
  // scheduled change is queued up.
  const pending = await c.var.DB.prepare(
    `SELECT effectiveFrom FROM maintenance_config_history
      WHERE scope = ? AND effectiveFrom > ?
      ORDER BY effectiveFrom ASC LIMIT 1`,
  )
    .bind(scope, today)
    .first<{ effectiveFrom: string }>();
  return c.json({
    success: true,
    data: parsed,
    effectiveFrom: row.effectiveFrom,
    hasPendingPriceChange: !!pending,
    pendingEffectiveFrom: pending?.effectiveFrom ?? null,
  });
});

// GET /api/maintenance-config/history?scope=...
app.get("/history", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  if (!scope) {
    return c.json({ success: false, error: "scope is required" }, 400);
  }
  const res = await c.var.DB.prepare(
    `SELECT id, scope, config, effectiveFrom, notes, createdAt, createdBy
       FROM maintenance_config_history
      WHERE scope = ?
      ORDER BY effectiveFrom DESC, createdAt DESC`,
  )
    .bind(scope)
    .all<Row>();
  const today = todayIso();
  const data = (res.results ?? []).map((r) => {
    let parsed: unknown = null;
    try { parsed = JSON.parse(r.config); } catch { /* keep null */ }
    return {
      id: r.id,
      scope: r.scope,
      config: parsed,
      effectiveFrom: r.effectiveFrom,
      notes: r.notes ?? "",
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      isPending: r.effectiveFrom > today,
    };
  });
  return c.json({ success: true, data });
});

// POST /api/maintenance-config/changes
// body: { scope, config, effectiveFrom, notes? }
app.post("/changes", async (c) => {
  // Reuse the existing kv_config permission gate so we don't have to seed
  // yet another resource — same admin role that could edit maintenance
  // before should be able to edit it now.
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  let body: {
    scope?: string;
    config?: unknown;
    effectiveFrom?: string;
    notes?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ success: false, error: "scope is required" }, 400);
  }
  const effectiveFrom = (body.effectiveFrom ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return c.json(
      { success: false, error: "effectiveFrom (YYYY-MM-DD) is required" },
      400,
    );
  }
  if (body.config === undefined || body.config === null) {
    return c.json({ success: false, error: "config is required" }, 400);
  }
  const id = genId();
  const configStr = JSON.stringify(body.config);
  await c.var.DB.prepare(
    `INSERT INTO maintenance_config_history
       (id, scope, config, effectiveFrom, notes, createdBy)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, scope, configStr, effectiveFrom, body.notes ?? null, null)
    .run();
  return c.json({
    success: true,
    data: {
      id,
      scope,
      config: body.config,
      effectiveFrom,
      notes: body.notes ?? "",
    },
  }, 201);
});

// DELETE /api/maintenance-config/changes/:id
app.delete("/changes/:id", async (c) => {
  const denied = await requirePermission(c, "users", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    `SELECT id FROM maintenance_config_history WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  await c.var.DB.prepare(
    `DELETE FROM maintenance_config_history WHERE id = ?`,
  )
    .bind(id)
    .run();
  return c.json({ success: true });
});

export default app;
