// ---------------------------------------------------------------------------
// audit-events read endpoint — feeds the AuditHistoryPanel component on
// every detail page (Sales / RD / Consignment / Customer / etc.). Returns
// the time-ordered audit_events for a single resource+resourceId pair, so
// the operator can see "who changed what and when" at a glance.
//
//   GET /api/audit-events?resource=sales-orders&resourceId=so-abc123
//
// Reads audit_events.beforeJson / afterJson as raw JSON strings — the SPA
// is in the better position to compute a field-level diff because it
// already knows which keys are user-meaningful (Total / Balance / Items)
// vs noise (updatedAt timestamps that change on every save).
//
// Permission: piggyback on the resource's read permission — if you can
// see the SO, you can see its history. We intentionally do NOT gate this
// behind a separate audit-read permission because the alternative (every
// staff role explicitly granted audit:read) was just shipping a dead-
// permission to every role anyway.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type AuditRow = {
  id: string;
  actorUserId: string | null;
  actorUserName: string | null;
  actorRole: string | null;
  resource: string;
  resourceId: string;
  action: string;
  beforeJson: string | null;
  afterJson: string | null;
  source: string;
  ipAddress: string | null;
  userAgent: string | null;
  ts: string;
};

// GET /api/audit-events?resource=X&resourceId=Y
//
// Required: resource + resourceId. Returns the last 200 events for that
// pair, newest first. The cap exists because no UI surface needs the
// full history at once — older events can be paged in via ?before=ts on
// a later iteration when someone hits a 200-event ceiling.
app.get("/", async (c) => {
  const resource = c.req.query("resource");
  const resourceId = c.req.query("resourceId");
  if (!resource || !resourceId) {
    return c.json(
      { success: false, error: "resource and resourceId query params are required" },
      400,
    );
  }

  // The header above has always DESCRIBED this piggyback rule — "if you can
  // read the resource, you can read its audit trail" — but no code implemented
  // it. Until now every authenticated session could read the before/after
  // snapshots of any record, including user rows, across every company.
  //
  // Gating on the CALLER-SUPPLIED `resource` is safe precisely because the same
  // value narrows the query below: you are checked against the resource whose
  // rows you get back, so naming one you may read cannot hand you another's.
  const denied = await requirePermission(c, resource, "read");
  if (denied) return denied;

  const limitParam = parseInt(c.req.query("limit") ?? "200", 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitParam) ? limitParam : 200));

  // audit_events.org_id exists and was never filtered on, so the trail crossed
  // tenants — prod runs four companies (HOOKKA / OHANA / HOUZS / HKMFG). NULL
  // is admitted for rows written before the column was populated; excluding
  // them would silently hide real history.
  const orgId = getOrgId(c);
  const res = await c.var.DB
    .prepare(
      `SELECT id, actorUserId, actorUserName, actorRole, resource, resourceId,
              action, beforeJson, afterJson, source, ipAddress, userAgent, ts
         FROM audit_events
        WHERE resource = ? AND resourceId = ?
          AND (orgId = ? OR orgId IS NULL)
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .bind(resource, resourceId, orgId, limit)
    .all<AuditRow>();

  // Pass JSON columns through as already-parsed objects so the SPA
  // doesn't have to JSON.parse twice (once in fetchJson, once on the
  // before/after blobs). null-safe: untouched events keep null.
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    actorUserName: r.actorUserName,
    actorRole: r.actorRole,
    resource: r.resource,
    resourceId: r.resourceId,
    action: r.action,
    before: r.beforeJson ? safeParse(r.beforeJson) : null,
    after: r.afterJson ? safeParse(r.afterJson) : null,
    source: r.source,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    ts: r.ts,
  }));

  return c.json({ success: true, data, total: data.length });
});

// Tolerate corrupted before/after blobs — return null instead of
// throwing so a single malformed row doesn't break the whole history
// load. Real-world cause: a route that JSON.stringified a value
// containing a circular ref or a BigInt; we'd rather show "[unparseable]"
// than 500 the entire endpoint.
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparseable: true, raw: s.slice(0, 500) };
  }
}

export default app;
