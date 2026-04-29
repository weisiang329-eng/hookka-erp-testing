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
import { emitCounter } from "./observability";

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
 * Build the prepared INSERT statement for one audit_events row WITHOUT
 * executing it. The caller appends the returned statement to its own
 * `db.batch([...])` so the audit row lands in the SAME transaction as
 * the underlying business mutation.
 *
 * Sprint 3 hardening: previously emitAudit ran AFTER the business batch,
 * with a try/catch that swallowed failures. That is wrong for two reasons:
 *   1. If the business batch commits but the audit insert fails, we have
 *      a mutation with no audit trail — recoverable via re-derivation but
 *      noisy at scale.
 *   2. The wider race window between mutation-commit and audit-commit
 *      means a request can be killed mid-flight and leave the journal
 *      half-written.
 * Folding the audit insert into the same transaction makes both writes
 * atomic — either the row changes AND the audit row exists, or neither.
 *
 * Returns null when the actor lookup or any other prep step fails — the
 * legacy behaviour of "never block the mutation" is preserved by the
 * caller checking for null and skipping the audit append.
 *
 * Note: the "best-effort displayName lookup" is deliberately dropped from
 * the inline path — fetching a user before computing the statement would
 * itself add a round-trip latency tax. The displayName backfill happens
 * inside the same transaction by querying users with a sub-SELECT.
 */
export async function buildAuditStatement(
  c: Context<Env>,
  event: AuditEvent,
): Promise<D1PreparedStatement | null> {
  try {
    const get = (c as unknown as { get: (k: string) => string | undefined }).get;
    const actorUserId = get.call(c, "userId") ?? null;
    const actorRole = get.call(c, "userRole") ?? null;

    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;
    const ua = (c.req.header("user-agent") ?? "").slice(0, 256) || null;

    const id = `aud-${crypto.randomUUID().slice(0, 12)}`;
    const beforeJson = event.before == null ? null : JSON.stringify(event.before);
    const afterJson = event.after == null ? null : JSON.stringify(event.after);
    const source: AuditSource = event.source ?? "ui";

    // Sub-SELECT against users for the snapshot of actor displayName. If
    // the lookup misses (deleted user, race) we fall back to NULL — the
    // journal still renders as "[deleted user]" downstream.
    const stmt = c.var.DB
      .prepare(
        `INSERT INTO audit_events (
           id, actorUserId, actorUserName, actorRole,
           resource, resourceId, action,
           beforeJson, afterJson, source, ipAddress, userAgent
         ) VALUES (
           ?, ?,
           (SELECT displayName FROM users WHERE id = ? LIMIT 1),
           ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .bind(
        id,
        actorUserId,
        actorUserId,
        actorRole,
        event.resource,
        event.resourceId,
        event.action,
        beforeJson,
        afterJson,
        source,
        ip,
        ua,
      );
    return stmt as unknown as D1PreparedStatement;
  } catch (e) {
    console.warn(
      `[audit] failed to BUILD statement resource=${event.resource} id=${event.resourceId} action=${event.action}:`,
      e,
    );
    return null;
  }
}

/**
 * Emit one audit_events row.  Fire-and-forget per-route — failures are
 * caught and logged but never thrown.
 *
 * This is the legacy entry point used where the mutation does NOT have a
 * batch to share. New code should prefer `buildAuditStatement` and append
 * the result to its own `db.batch([...])`.
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
    // P6.3 — count successful inserts as a metric so the dashboard can
    // chart audit-write throughput. Cast c through the looser observability
    // signature; emitCounter never throws on shape mismatch.
    emitCounter(c as unknown as Context, "audit_events.created", {
      resource: event.resource,
      action: String(event.action),
    });
  } catch (e) {
    // NEVER throw — audit failure must not block the underlying mutation.
    console.warn(
      `[audit] failed to emit resource=${event.resource} id=${event.resourceId} action=${event.action}:`,
      e,
    );
  }
}

/**
 * Helper: emit a "create"-class metric counter for an audit event after
 * the parent batch commits successfully. Use after a batch that included
 * a buildAuditStatement() result so the dashboard counters mirror the
 * old emitAudit() behaviour. Failures are swallowed.
 */
export function recordAuditCreatedMetric(
  c: Context<Env>,
  event: Pick<AuditEvent, "resource" | "action">,
): void {
  try {
    emitCounter(c as unknown as Context, "audit_events.created", {
      resource: event.resource,
      action: String(event.action),
    });
  } catch {
    /* metrics failures are silent */
  }
}
