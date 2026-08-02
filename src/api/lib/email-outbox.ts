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
import { sendMail, type EmailAttachment } from "./email";
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
  /**
   * Optional base64 file attachments (e.g. the DO / Invoice PDF on the
   * customer dispatch + invoice notices). Stored in outbox_emails.
   * attachments_json (migration 0161) and forwarded by the drain to the
   * provider. Total DECODED size is capped at MAX_ATTACHMENT_TOTAL_BYTES —
   * oversize payloads are enqueued WITHOUT the attachment (console.warn)
   * so the email itself still goes out.
   */
  attachments?: EmailAttachment[];
}

// 5 MB decoded — comfortably under both Resend's and Brevo's per-message
// limits while keeping the outbox row (and the drain's Resend POST) sane.
export const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

/** Decoded byte length of a base64 string (without actually decoding). */
export function base64DecodedBytes(b64: string): number {
  const s = (b64 || "").trim();
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

/**
 * Validate the attachment list for enqueue. Drops the WHOLE list (returning
 * null + a console.warn) when malformed or when the combined decoded size
 * exceeds the 5 MB cap — the email is still enqueued, just without the
 * attachment, because a notice without a PDF beats no notice at all.
 */
export function sanitizeAttachments(
  attachments: EmailAttachment[] | undefined,
): EmailAttachment[] | null {
  if (!attachments || attachments.length === 0) return null;
  const cleaned: EmailAttachment[] = [];
  let totalBytes = 0;
  for (const a of attachments) {
    const filename = String(a?.filename || "").trim();
    const contentBase64 = String(a?.contentBase64 || "").trim();
    if (!filename || !contentBase64) continue;
    totalBytes += base64DecodedBytes(contentBase64);
    cleaned.push({ filename, contentBase64 });
  }
  if (cleaned.length === 0) return null;
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    console.warn(
      `[email-outbox] attachments dropped — ${totalBytes} bytes decoded exceeds the ${MAX_ATTACHMENT_TOTAL_BYTES}-byte cap; enqueueing without attachment`,
    );
    return null;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Self-applying migration for the attachments_json column (mirrors
// migrations-postgres/0161_outbox_attachments.sql). Module-level promise =
// one round of ALTER per isolate boot — same pattern as
// ensurePendingMigrations in src/api/routes/sales-orders.ts. Runs at BOTH
// the enqueue and the drain so deploy ordering can't break either side.
// attachments_json is snake_case like its sibling columns, so it passes
// translateSql() untouched and lands exactly as spelled.
// ---------------------------------------------------------------------------
let outboxMigrations = false;
async function ensureOutboxMigrations(db: D1Database): Promise<void> {
  if (outboxMigrations) return;

  try {
    await db
      .prepare(
        "ALTER TABLE outbox_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT",
      )
      .run();
  } catch {
    // ignore — column may already exist or DDL transiently rejected; a
    // real schema error resurfaces on the INSERT/SELECT with a clearer
    // message.
  }
  // Widen the status CHECK to allow 'SENDING' — the atomic-claim status the
  // drain sets on a row BEFORE contacting the provider (the per-row lock that
  // stops the eager push racing the cron into a double-send). Migration 0081
  // only allowed PENDING/SENT/FAILED/RETRYING, so that claim UPDATE violated
  // outbox_emails_status_check and THREW, 500ing the ENTIRE drain on the very
  // first row — the queue never delivered (2026-06-24: 50 customer DO/Invoice
  // notices stuck PENDING for 12h+, surfaced by the new Auto-sent view).
  // Postgres has no ADD CONSTRAINT IF NOT EXISTS, so drop + re-add; both are
  // wrapped so a transient DDL rejection never poisons the cached promise.
  // The new set is a superset of every status already in the table, so the
  // re-ADD validates cleanly. Runs once per isolate boot (cached promise).
  try {
    await db
      .prepare(
        "ALTER TABLE outbox_emails DROP CONSTRAINT IF EXISTS outbox_emails_status_check",
      )
      .run();
  } catch {
    /* ignore — constraint absent / transient DDL rejection */
  }
  try {
    await db
      .prepare(
        "ALTER TABLE outbox_emails ADD CONSTRAINT outbox_emails_status_check CHECK (status IN ('PENDING','SENDING','RETRYING','SENT','FAILED'))",
      )
      .run();
  } catch {
    /* ignore — already present, or a concurrent isolate re-added it */
  }
  outboxMigrations = true;
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
  // Make sure the attachments_json column exists before the INSERT names it
  // (runtime self-apply of migration 0161; no-op after the first call).
  await ensureOutboxMigrations(c.var.DB);
  const attachments = sanitizeAttachments(args.attachments);
  // NB: column identifiers are spelled in snake_case to match the migration
  // (0081_email_outbox.sql). The translateSql() identifier rewriter in
  // supabase-compat.ts only rewrites camelCase identifiers that appear in
  // column-rename-map.json — and to_address/body_html/body_text/payload_json/
  // last_attempt_at/sent_at/last_error are NOT in that map. Using camelCase
  // here would slip through translateSql unchanged and Postgres would reject
  // the query ("column toaddress does not exist"). Same shape as audit-replay.ts.
  await c.var.DB.prepare(
    `INSERT INTO outbox_emails (id, to_address, subject, body_html, body_text, payload_json, attachments_json, org_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      args.to,
      args.subject,
      args.html,
      args.text ?? null,
      args.payloadJson ? JSON.stringify(args.payloadJson) : null,
      attachments ? JSON.stringify(attachments) : null,
      orgId,
    )
    .run();

  // Eager push: kick a background drain so this email goes out within seconds
  // instead of waiting for the 5-min cron (which GitHub Actions runs hours
  // apart in practice — Wei Siang 2026-06-16: "driver scan 了, invoice 為什麼
  //沒有自動發"). The row is already committed, so this is purely an
  // optimisation; the cron stays the backstop/retry path. Non-blocking
  // (waitUntil) so the user's request returns immediately, and processOutbox's
  // atomic per-row claim makes racing the cron safe (no double-send).
  try {
    c.executionCtx?.waitUntil(
      processOutbox(c.var.DB, c.env).catch((err: unknown) => {
        // Swallow — the cron will retry. Never fail an enqueue over the push.
        console.warn(
          "[email-outbox] eager drain failed (cron will retry):",
          err,
        );
      }),
    );
  } catch {
    // No executionCtx (unit tests / non-Worker invocation) — fine, the cron
    // drains it. Accessing c.executionCtx can throw when unset, hence the try.
  }
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
// A row claimed (status='SENDING') but never finished — e.g. the immediate
// post-enqueue drain's waitUntil isolate was evicted mid-send — is reclaimed
// after this window so it's never stranded.
const STALE_SENDING_MS = 5 * 60_000;

// Batch-pick row — METADATA ONLY (the body/attachments are fetched per-row in
// the loop; see processOutbox). Keeping the pick light is what stops a queue of
// PDF-bearing invoices from OOM-ing the whole drain.
interface OutboxRow {
  id: string;
  toAddress: string;
  subject: string;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
}

// Parse the stored attachments_json back into the provider-neutral shape.
// Bad/legacy values (NULL, truncated JSON, wrong shape) degrade to "no
// attachment" — never fail the send over the attachment.
function parseStoredAttachments(
  raw: string | null,
): EmailAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed
      .map((a) => ({
        filename: String((a as EmailAttachment)?.filename || "").trim(),
        contentBase64: String(
          (a as EmailAttachment)?.contentBase64 || "",
        ).trim(),
      }))
      .filter((a) => a.filename && a.contentBase64);
    return list.length > 0 ? list : undefined;
  } catch {
    return undefined;
  }
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
  env: {
    RESEND_API_KEY?: string;
    BREVO_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
  },
): Promise<ProcessOutboxResult> {
  const result: ProcessOutboxResult = {
    picked: 0,
    sent: 0,
    retrying: 0,
    failed: 0,
    skippedBackoff: 0,
  };

  if (!env.RESEND_API_KEY && !env.BREVO_API_KEY) {
    // No API key configured — log and skip. The endpoint should still
    // return ok so the cron job doesn't keep retrying nothing.
    console.warn("[email-outbox] no email provider configured; skipping drain");
    return result;
  }
  const from =
    env.RESEND_FROM_EMAIL ||
    "Hookka Manufacturing ERP <noreply@hookka.com>";

  // attachments_json may predate this isolate's schema — self-apply the
  // 0161 column before the SELECT names it (no-op after the first call).
  await ensureOutboxMigrations(db);

  // Columns are snake_case in DB (see migration 0081). Aliases pin the
  // result-set keys back to camelCase so OutboxRow stays readable; we can't
  // rely on the global snake→camel transform (transform.column.from in
  // db-pg.ts) because the outbox columns aren't in column-rename-map.json.
  // createdAt is in the rename map but using created_at literally keeps the
  // ORDER BY clause matching the migration's column name 1:1.
  // Reclaim crashed claims: a row stuck at 'SENDING' past the window (its
  // immediate-send isolate died before it could mark the row) becomes
  // pickable again, so an evicted eager push never strands an email.
  const staleThreshold = new Date(Date.now() - STALE_SENDING_MS).toISOString();

  // Lightweight pick — METADATA ONLY. body_html / body_text / attachments_json
  // (the DO/Invoice PDFs ride attachments_json as base64) are fetched PER ROW
  // inside the loop. Pulling all of them for a 25-row batch in ONE result set
  // blew past the Worker's memory/response budget once a batch of PDF-bearing
  // invoices queued up, so .all() THREW → the cron handler 500'd → the ENTIRE
  // queue stranded (nothing sent, nothing even marked failed). 2026-06-24
  // BUG: 50 customer DO/Invoice notices stuck PENDING for 12h+.
  const pickRes = await db
    .prepare(
      `SELECT id,
              to_address      AS "toAddress",
              subject,
              status,
              attempts,
              last_attempt_at AS "lastAttemptAt"
         FROM outbox_emails
        WHERE status IN ('PENDING','RETRYING')
           OR (status = 'SENDING' AND last_attempt_at < ?)
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(staleThreshold, BATCH_SIZE)
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

    // Atomic claim — flip this row out of the pickable set BEFORE sending so a
    // concurrent drain can't double-send a customer email. The eager
    // post-enqueue push (added so mail goes out in seconds) now races the
    // 5-min cron, and a single batch can fire several pushes at once. Postgres
    // serialises the UPDATEs on the row, so only the winner sees a pickable
    // status → changes=1; everyone else no-ops and skips. The OR clause mirrors
    // the SELECT so a crashed claim is re-grabbable. Same meta.changes race
    // pattern as edit-lock-override.ts / po-cost-cascade.ts.
    const claim = await db
      .prepare(
        `UPDATE outbox_emails
            SET status = 'SENDING', last_attempt_at = ?
          WHERE id = ?
            AND (status IN ('PENDING','RETRYING')
                 OR (status = 'SENDING' AND last_attempt_at < ?))`,
      )
      .bind(new Date().toISOString(), row.id, staleThreshold)
      .run();
    if (
      ((claim as unknown as { meta?: { changes?: number } }).meta?.changes ??
        0) === 0
    ) {
      // Lost the race — another drain owns this row now.
      continue;
    }

    const newAttempts = row.attempts + 1;
    const nowIso = new Date().toISOString();

    // Per-row isolation: a single poison row (oversize body, malformed
    // attachment, a transient DB/provider blip) must NEVER throw out of the
    // loop and strand the rest of the batch — that was the 2026-06-24 bug.
    try {
      // Lazy per-row body fetch (see the pick comment above) — ONE row's
      // payload is safely within budget even when it carries a ~MB PDF.
      const full = await db
        .prepare(
          `SELECT body_html       AS "bodyHtml",
                  body_text       AS "bodyText",
                  attachments_json AS "attachmentsJson"
             FROM outbox_emails WHERE id = ? LIMIT 1`,
        )
        .bind(row.id)
        .first<{
          bodyHtml: string | null;
          bodyText: string | null;
          attachmentsJson: string | null;
        }>();

      const send = await sendMail(env, from, {
        to: row.toAddress,
        subject: row.subject,
        html: full?.bodyHtml ?? "",
        text: full?.bodyText ?? undefined,
        // Stored attachments ride along to the provider (Resend `attachments`
        // / Brevo `attachment`); rows without a value behave exactly as before.
        attachments: parseStoredAttachments(full?.attachmentsJson ?? null),
      });

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
    } catch (rowErr) {
      // The poison-row guard. Record the real reason on the row (visible in the
      // Mail Center "Auto-sent" view) and keep draining the rest of the batch.
      const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
      console.error("[email-outbox] row", row.id, "failed:", msg);
      try {
        const terminal = newAttempts >= MAX_ATTEMPTS;
        await db
          .prepare(
            `UPDATE outbox_emails
                SET status = ?, attempts = ?, last_attempt_at = ?, last_error = ?
              WHERE id = ?`,
          )
          .bind(
            terminal ? "FAILED" : "RETRYING",
            newAttempts,
            nowIso,
            msg.slice(0, 500),
            row.id,
          )
          .run();
        if (terminal) result.failed++;
        else result.retrying++;
      } catch (bookErr) {
        // Even the bookkeeping write failed — the stale-SENDING reclaim picks
        // this row up next tick. Log and carry on; never strand the batch.
        console.error(
          "[email-outbox] row",
          row.id,
          "status write also failed:",
          bookErr instanceof Error ? bookErr.message : String(bookErr),
        );
      }
    }
  }

  return result;
}
