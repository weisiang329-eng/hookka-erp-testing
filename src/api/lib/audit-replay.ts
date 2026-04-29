// ---------------------------------------------------------------------------
// Phase 2 / P2 follow-up — audit_dlq replay sweeper.
//
// Sprint 2 task 6 created the audit_dlq table (migrations-postgres/0080) and
// wired production-orders.ts to dead-letter failed job_card_events batches
// into it. Without a replay path, those rows accumulate forever and the
// audit log silently stays incomplete.
//
// This module provides `replayAuditDlq(c, limit)`:
//   1. SELECT pending rows (replayed_at IS NULL), oldest-first, LIMIT n.
//   2. For each row, dispatch on `error_kind`:
//        - "job_card_events.batch_failed" -> INSERT job_card_events rows
//          (one per JobCardEventInput in the original_payload array).
//        - "audit_events.insert_failed"   -> INSERT one audit_events row
//          (the payload is a single record matching the audit.ts shape).
//        - anything else                  -> log warn, leave pending so a
//          human can investigate.
//   3. On success, UPDATE audit_dlq SET replayed_at = now() WHERE id = ?.
//   4. On per-row failure, leave replayed_at NULL and log warn — the next
//      cron tick will retry. (No `attempts` column today; if the migration
//      grows one, we can bump it here without changing the contract.)
//
// Returns counters so the cron endpoint can echo them back for monitoring.
//
// Pure of Hono context — takes a D1Database handle directly so it can also
// be invoked from tests / scripts. The route handler in worker.ts wraps
// this with the CRON_SECRET gate.
// ---------------------------------------------------------------------------

import type { JobCardEventInput } from "./job-card-events";
import { buildJobCardEventStatement } from "./job-card-events";

export type AuditReplayResult = {
  /** Rows seen as pending in this batch (≤ limit). */
  pending: number;
  /** Rows successfully replayed and marked replayed_at = now(). */
  replayed: number;
  /** Rows whose replay attempt threw — left pending for the next tick. */
  failed: number;
};

type DlqRow = {
  id: string;
  original_payload: string;
  error_message: string;
  error_kind: string;
  attempted_at: string;
  replayed_at: string | null;
};

/**
 * Drain up to `limit` pending audit_dlq rows.
 *
 * Caller is responsible for auth (this is invoked from the CRON_SECRET-gated
 * /api/internal/replay-audit-dlq endpoint). Idempotent: replayed rows are
 * marked replayed_at and the partial-unique index on (replayed_at IS NULL)
 * means re-running the sweeper before another failure won't re-process
 * already-recovered events.
 */
export async function replayAuditDlq(
  db: D1Database,
  limit = 100,
): Promise<AuditReplayResult> {
  // Defensive cap — even if a caller passes a huge number, we don't want
  // to chew through unbounded rows in a single Workers invocation.
  const safeLimit = Math.max(1, Math.min(limit, 500));

  const pendingRes = await db
    .prepare(
      `SELECT id, original_payload, error_message, error_kind, attempted_at, replayed_at
         FROM audit_dlq
        WHERE replayed_at IS NULL
        ORDER BY attempted_at ASC
        LIMIT ?`,
    )
    .bind(safeLimit)
    .all<DlqRow>();

  const rows = pendingRes.results ?? [];
  let replayed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await replayOne(db, row);
      await db
        .prepare("UPDATE audit_dlq SET replayed_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), row.id)
        .run();
      replayed += 1;
    } catch (err) {
      failed += 1;
      // Leave replayed_at NULL — the next tick will pick this row up again.
      // Loud log so wrangler tail surfaces the unhealthy row + reason.
      console.warn(
        `[audit-replay] row ${row.id} (kind=${row.error_kind}) replay failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { pending: rows.length, replayed, failed };
}

/**
 * Dispatch a single DLQ row back to its original write target. Throws on
 * any failure; the caller catches and counts.
 *
 * Kept narrow on purpose: every supported error_kind is enumerated here,
 * so a typo'd kind in some future writer fails LOUDLY rather than silently
 * accumulating rows the sweeper doesn't know how to handle.
 */
async function replayOne(db: D1Database, row: DlqRow): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(row.original_payload);
  } catch (e) {
    throw new Error(
      `audit_dlq row ${row.id}: original_payload is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  switch (row.error_kind) {
    case "job_card_events.batch_failed":
      await replayJobCardEventsBatch(db, payload);
      return;
    case "audit_events.insert_failed":
      await replayAuditEventsInsert(db, payload);
      return;
    default:
      throw new Error(
        `audit_dlq row ${row.id}: unknown error_kind "${row.error_kind}" — sweeper does not know how to replay this`,
      );
  }
}

/**
 * Replay a job_card_events batch. The original payload is a JSON-stringified
 * array of JobCardEventInput rows (see production-orders.ts ~line 2018).
 */
async function replayJobCardEventsBatch(
  db: D1Database,
  payload: unknown,
): Promise<void> {
  if (!Array.isArray(payload)) {
    throw new Error(
      "job_card_events.batch_failed payload must be an array of events",
    );
  }
  if (payload.length === 0) {
    // Empty array is a no-op success — the original write would also have
    // been a no-op. Mark replayed so we don't keep it pending.
    return;
  }
  const stmts = (payload as JobCardEventInput[]).map((evt) =>
    buildJobCardEventStatement(db, evt),
  );
  // db.batch wraps these in an implicit transaction (matches the original
  // write path in production-orders.ts).
  await db.batch(stmts);
}

/**
 * Replay an audit_events insert. The payload shape mirrors the bind() args
 * in src/api/lib/audit.ts emitAudit(). For now no writer DLQ-ing into this
 * kind exists, but we wire the dispatch up-front so the migration's
 * documented "future kind" is supported when it lands.
 */
async function replayAuditEventsInsert(
  db: D1Database,
  payload: unknown,
): Promise<void> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      "audit_events.insert_failed payload must be a single object",
    );
  }
  const p = payload as Record<string, unknown>;
  const required = ["id", "resource", "action"];
  for (const k of required) {
    if (!(k in p)) {
      throw new Error(
        `audit_events.insert_failed payload missing required field "${k}"`,
      );
    }
  }
  await db
    .prepare(
      `INSERT INTO audit_events (
         id, actorUserId, actorUserName, actorRole,
         resource, resourceId, action,
         beforeJson, afterJson, source, ipAddress, userAgent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id ?? null,
      p.actorUserId ?? null,
      p.actorUserName ?? null,
      p.actorRole ?? null,
      p.resource ?? null,
      p.resourceId ?? null,
      p.action ?? null,
      p.beforeJson ?? null,
      p.afterJson ?? null,
      p.source ?? null,
      p.ipAddress ?? null,
      p.userAgent ?? null,
    )
    .run();
}
