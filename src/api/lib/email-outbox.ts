// ---------------------------------------------------------------------------
// Email outbox enqueue + cron drain helper — Sprint 4.
//
// Replaces direct Resend POSTs at call-time with a durable INSERT into
// outbox_emails. The cron job (.github/workflows/process-email-outbox.yml)
// drains pending rows by POSTing to /api/internal/process-email-outbox
// every 5 min; the endpoint reads pending rows, calls Resend, and marks
// status. 3 retries with exponential backoff before FAILED.
//
// The migration that creates the table lives at
// migrations-postgres/0081_email_outbox.sql.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { sendEmail } from "./email";
import { tryGetOrgId } from "./tenant";

export interface EnqueueEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Optional structured payload for future template-driven sends. Today
   * the renderer bakes html/text directly so this stays null in normal
   * use; pass it when you want to defer rendering to the cron worker
   * (e.g. invite expiry calculated at SEND time, not enqueue time).
   */
  payloadJson?: Record<string, unknown>;
}

/**
 * Insert a pending row into outbox_emails. Returns the generated id so
 * the caller can correlate logs.
 *
 * Enqueue is the ONLY operation that runs on the user's request thread —
 * it's a single INSERT, sub-millisecond on Hyperdrive. Resend contact is
 * deferred to the cron drain so a Resend outage cannot brown out the API.
 */
export async function enqueueEmail<E extends Env>(
  c: Context<E>,
  args: EnqueueEmailArgs,
): Promise<{ id: string }> {
  const id = `oe-${crypto.randomUUID().slice(0, 8)}`;
  // Try to scope the email to the active org. Fall back to 'hookka' for
  // pre-auth flows (invite acceptance) where there's no userId yet — the
  // column has DEFAULT 'hookka' and the cron drain doesn't filter by
  // org_id, so this is purely informational.
  const orgId = tryGetOrgId(c) ?? "hookka";
  // NB: column identifiers are spelled in snake_case to match the migration
  // (0081_email_outbox.sql). The translateSql() identifier rewriter in
  // supabase-compat.ts only rewrites camelCase identifiers that appear in
  // column-rename-map.json — and to_address/body_html/body_text/payload_json/
  // last_attempt_at/sent_at/last_error are NOT in that map. Using camelCase
  // here would slip through translateSql unchanged and Postgres would reject
  // the query ("column toaddress does not exist"). Same shape as audit-replay.ts.
  await c.var.DB.prepare(
    `INSERT INTO outbox_emails (id, to_address, subject, body_html, body_text, payload_json, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      args.to,
      args.subject,
      args.html,
      args.text ?? null,
      args.payloadJson ? JSON.stringify(args.payloadJson) : null,
      orgId,
    )
    .run();
  return { id };
}

// ---------------------------------------------------------------------------
// Cron drain — called by /api/internal/process-email-outbox once every
// 5 min. Picks up at most BATCH_SIZE PENDING/RETRYING rows ordered by
// created_at, calls Resend for each, and marks the row.
//
// Retry policy: max 3 attempts. Backoff is enforced via the
// last_attempt_at column — we skip RETRYING rows whose last attempt was
// less than backoffSecondsForAttempt(attempts) ago, so the next run picks
// them up after the backoff window.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 25;

interface OutboxRow {
  id: string;
  toAddress: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
}

/**
 * Exponential backoff: attempt 0 -> 0s (first try), 1 -> 60s, 2 -> 300s.
 * Fits inside a 5-min cron tick so a transient blip retries the next
 * tick; a longer outage bubbles past the 3-attempt cap into FAILED
 * within ~6 minutes total.
 */
function backoffSecondsForAttempt(attempts: number): number {
  switch (attempts) {
    case 0:
      return 0;
    case 1:
      return 60;
    case 2:
      return 300;
    default:
      return 900;
  }
}

export interface ProcessOutboxResult {
  picked: number;
  sent: number;
  retrying: number;
  failed: number;
  skippedBackoff: number;
}

export async function processOutbox(
  db: D1Database,
  env: { RESEND_API_KEY?: string; RESEND_FROM_EMAIL?: string },
): Promise<ProcessOutboxResult> {
  const result: ProcessOutboxResult = {
    picked: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    skippedBackoff: 0,
  };

  if (!env.RESEND_API_KEY) {
    // No API key configured — log and skip. The endpoint should still
    // return ok so the cron job doesn't keep retrying nothing.
    console.warn("[email-outbox] RESEND_API_KEY not configured; skipping drain");
    return result;
  }
  const from =
    env.RESEND_FROM_EMAIL ||
    "Hookka Manufacturing ERP <noreply@houzscentury.com>";

  // Columns are snake_case in DB (see migration 0081). Aliases pin the
  // result-set keys back to camelCase so OutboxRow stays readable; we can't
  // rely on the global snake→camel transform (transform.column.from in
  // db-pg.ts) because the outbox columns aren't in column-rename-map.json.
  // createdAt is in the rename map but using created_at literally keeps the
  // ORDER BY clause matching the migration's column name 1:1.
  const pickRes = await db
    .prepare(
      `SELECT id,
              to_address      AS "toAddress",
              subject,
              body_html       AS "bodyHtml",
              body_text       AS "bodyText",
              status,
              attempts,
              last_attempt_at AS "lastAttemptAt"
         FROM outbox_emails
        WHERE status IN ('PENDING','RETRYING')
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(BATCH_SIZE)
    .all<OutboxRow>();

  const rows = pickRes.results ?? [];
  result.picked = rows.length;

  const nowMs = Date.now();
  for (const row of rows) {
    // Backoff gate: a RETRYING row whose lastAttemptAt is within the
    // backoff window stays pending until the next tick. Don't reset
    // attempts so the count keeps climbing toward MAX_ATTEMPTS.
    if (row.status === "RETRYING" && row.lastAttemptAt) {
      const lastMs = new Date(row.lastAttemptAt).getTime();
      const elapsedS = Math.floor((nowMs - lastMs) / 1000);
      if (elapsedS < backoffSecondsForAttempt(row.attempts)) {
        result.skippedBackoff++;
        continue;
      }
    }

    const send = await sendEmail(env.RESEND_API_KEY, from, {
      to: row.toAddress,
      subject: row.subject,
      html: row.bodyHtml ?? "",
      text: row.bodyText ?? undefined,
    });

    const newAttempts = row.attempts + 1;
    const nowIso = new Date().toISOString();

    if (send.ok) {
      await db
        .prepare(
          `UPDATE outbox_emails
              SET status = 'SENT', attempts = ?, last_attempt_at = ?, sent_at = ?, last_error = NULL
            WHERE id = ?`,
        )
        .bind(newAttempts, nowIso, nowIso, row.id)
        .run();
      result.sent++;
      continue;
    }

    if (newAttempts >= MAX_ATTEMPTS) {
      await db
        .prepare(
          `UPDATE outbox_emails
              SET status = 'FAILED', attempts = ?, last_attempt_at = ?, last_error = ?
            WHERE id = ?`,
        )
        .bind(newAttempts, nowIso, send.error ?? "unknown", row.id)
        .run();
      result.failed++;
    } else {
      await db
        .prepare(
          `UPDATE outbox_emails
              SET status = 'RETRYING', attempts = ?, last_attempt_at = ?, last_error = ?
            WHERE id = ?`,
        )
        .bind(newAttempts, nowIso, send.error ?? "unknown", row.id)
        .run();
      result.retrying++;
    }
  }

  return result;
}
