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

// Shared resolver — used by /resolved and by the customer-quotation envelope
// endpoint. Picks the newest history row WHERE effectiveFrom <= asOf and
// returns the parsed config + a flag/date for the next pending change.
async function resolveMaintenanceConfigAsOf(
  db: D1Database,
  scope: string,
  asOf: string,
): Promise<{
  config: unknown;
  effectiveFrom: string | null;
  hasPendingPriceChange: boolean;
  pendingEffectiveFrom: string | null;
}> {
  const row = await db
    .prepare(
      `SELECT id, scope, config, effectiveFrom, notes, createdAt, createdBy
         FROM maintenance_config_history
        WHERE scope = ? AND effectiveFrom <= ?
        ORDER BY effectiveFrom DESC, createdAt DESC
        LIMIT 1`,
    )
    .bind(scope, asOf)
    .first<Row>();
  if (!row) {
    return {
      config: null,
      effectiveFrom: null,
      hasPendingPriceChange: false,
      pendingEffectiveFrom: null,
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    parsed = null;
  }
  const pending = await db
    .prepare(
      `SELECT effectiveFrom FROM maintenance_config_history
        WHERE scope = ? AND effectiveFrom > ?
        ORDER BY effectiveFrom ASC LIMIT 1`,
    )
    .bind(scope, asOf)
    .first<{ effectiveFrom: string }>();
  return {
    config: parsed,
    effectiveFrom: row.effectiveFrom,
    hasPendingPriceChange: !!pending,
    pendingEffectiveFrom: pending?.effectiveFrom ?? null,
  };
}

// GET /api/maintenance-config/resolved?scope=...&asOf=YYYY-MM-DD
// asOf defaults to today; lets callers preview future-dated configs and
// (more usefully here) lets the customer-quotation envelope serve a
// historical/future date with the same resolver semantics.
app.get("/resolved", async (c) => {
  const scope = parseScope(c.req.query("scope"));
  if (!scope) {
    return c.json({ success: false, error: "scope is required" }, 400);
  }
  const asOfRaw = (c.req.query("asOf") ?? "").trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : todayIso();
  const resolved = await resolveMaintenanceConfigAsOf(c.var.DB, scope, asOf);
  if (resolved.config === null && resolved.effectiveFrom === null) {
    return c.json({ success: true, data: null });
  }
  return c.json({
    success: true,
    data: resolved.config,
    effectiveFrom: resolved.effectiveFrom,
    hasPendingPriceChange: resolved.hasPendingPriceChange,
    pendingEffectiveFrom: resolved.pendingEffectiveFrom,
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
export { resolveMaintenanceConfigAsOf };
