// ---------------------------------------------------------------------------
// audit.ts — Phase 3 P3.4 unified audit emit.
//
// Writes one row to audit_events (created by 0046_audit_events.sql) per
// sensitive mutation. Snapshot semantics per the migration:
//   create  → before=null,    after=row JSON
//   update  → before=row JSON, after=row JSON
//   delete  → before=row JSON, after=null
//   action  → before=null,    after=null
//
// Actor (userId / role) is snapshotted at write time from the Hono context
// (auth-middleware stamps userId / userRole). User name is fetched once
// best-effort — failure to look it up is silently ignored so a flaky users
// table never blocks a business mutation.
//
// Failure model: errors are CAUGHT and logged via console.warn, NOT thrown.
// Missing audit rows are recoverable via re-deriving from domain tables;
// blocking a real mutation because audit failed is unrecoverable.
//
// Usage in a Hono route:
//   import { emitAudit } from "../lib/audit";
//   await emitAudit(c, {
//     resource: "sales-orders",
//     resourceId: id,
//     action: "create",
//     after: rowToSO(created, items),
//   });
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "confirm"
  | "cancel"
  | "post"
  | "void"
  | "approve"
  | "reject"
  | "submit"
  | "scan"
  | "login"
  | "logout"
  | "role-change"
  | string; // open-ended for module-specific actions

export type AuditSource = "ui" | "api" | "scan" | "admin" | "cron" | "system";

export interface AuditEvent {
  resource: string;     // "sales-orders" | "invoices" | "job-cards" | ...
  resourceId: string;   // the row PK
  action: AuditAction;
  before?: unknown;     // pre-state snapshot (null for create/action)
  after?: unknown;      // post-state snapshot (null for delete/action)
  source?: AuditSource; // default 'ui'
}

/**
 * Emit one audit_events row.  Fire-and-forget per-route — failures are
 * caught and logged but never thrown.
 */
export async function emitAudit(
  c: Context<Env>,
  event: AuditEvent,
): Promise<void> {
  try {
    const get = (c as unknown as { get: (k: string) => string | undefined }).get;
    const actorUserId = get.call(c, "userId") ?? null;
    const actorRole = get.call(c, "userRole") ?? null;

    // Best-effort displayName lookup. We snapshot it so the journal still
    // renders if the user is later deleted.
    let actorUserName: string | null = null;
    if (actorUserId) {
      try {
        const u = await c.var.DB
          .prepare("SELECT displayName FROM users WHERE id = ? LIMIT 1")
          .bind(actorUserId)
          .first<{ displayName: string | null }>();
        actorUserName = u?.displayName ?? null;
      } catch {
        /* lookup failure is non-fatal */
      }
    }

    // IP + UA from request headers.  Cloudflare populates cf-connecting-ip
    // for the real client; fall back to x-forwarded-for chain.
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;
    const ua = (c.req.header("user-agent") ?? "").slice(0, 256) || null;

    const id = `aud-${crypto.randomUUID().slice(0, 12)}`;
    const beforeJson = event.before == null ? null : JSON.stringify(event.before);
    const afterJson = event.after == null ? null : JSON.stringify(event.after);
    const source: AuditSource = event.source ?? "ui";

    await c.var.DB
      .prepare(
        `INSERT INTO audit_events (
           id, actorUserId, actorUserName, actorRole,
           resource, resourceId, action,
           beforeJson, afterJson, source, ipAddress, userAgent
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        actorUserId,
        actorUserName,
        actorRole,
        event.resource,
        event.resourceId,
        event.action,
        beforeJson,
        afterJson,
        source,
        ip,
        ua,
      )
      .run();
  } catch (e) {
    // NEVER throw — audit failure must not block the underlying mutation.
    console.warn(
      `[audit] failed to emit resource=${event.resource} id=${event.resourceId} action=${event.action}:`,
      e,
    );
  }
}
