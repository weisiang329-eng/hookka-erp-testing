// ---------------------------------------------------------------------------
// Edit-Lock Override helpers — admin escape hatch for the Rule-3
// "production_window" lock on Sales Orders + Consignment Orders.
//
// Background (per user 2026-04-28):
//   /:id/edit-eligibility enforces three rules to lock editing once the
//   order has crossed into active production:
//     Rule 1: status NOT IN (DRAFT, CONFIRMED, IN_PRODUCTION) → hard lock.
//     Rule 2: any job_card under the order's POs has a completedDate
//             stamped → hard lock (real production output exists).
//     Rule 3: MIN(job_cards.dueDate) <= today + 2 days → "production_window"
//             lock — first scheduled production step is within 2 days.
//
//   ADMIN / SUPER_ADMIN can OVERRIDE Rule 3 with a written reason. They
//   CANNOT override Rule 1 or Rule 2:
//     - Rule 1 is the state machine (CANCELLED / SHIPPED / etc. don't have
//       a meaningful "edit" semantic at all — there's nothing live to edit).
//     - Rule 2 protects committed production OUTPUT. Once a JC has a
//       completedDate, real units exist and editing items would orphan
//       finished WIP. No reason text can undo that physical commitment.
//   Rule 3, by contrast, is a *soft* schedule-drift guard (no output yet —
//   we just don't want material orders / cutting plans to drift). The
//   admin overriding is explicitly accepting that schedule risk, and the
//   override is audit-trailed (reason + actor + ISO timestamp) for
//   forensic review.
//
// Token lifecycle:
//   POST /:id/override-edit-lock writes a row in edit_lock_overrides
//   (migration 0071) with expires_at = now + 60 min and returns the UUID.
//   The FE forwards it on the next PUT body as `overrideToken`. The PUT
//   handler calls consumeEditLockOverrideToken() which verifies the token
//   (matches order, not expired, not yet used), atomically stamps used_at,
//   and returns true on success — the PUT then skips the production_window
//   pre-flight check. Rule 1 + Rule 2 are STILL re-checked on every PUT.
// ---------------------------------------------------------------------------

export type EditLockOrderType = "SO" | "CO";

/** TTL for the override token. 60 minutes is long enough for the admin to
 *  click through the modal + edit form + Save without the token expiring,
 *  but short enough that a stolen / leaked token has a tight blast radius. */
export const OVERRIDE_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Minimum length (after trim) the override reason must satisfy. Anything
 *  shorter than this is almost certainly a smashed-keyboard placeholder
 *  (e.g. "x", "asdf") and useless for forensic review later. */
export const MIN_OVERRIDE_REASON_LEN = 5;

export interface CreateOverrideParams {
  orderType: EditLockOrderType;
  orderId: string;
  reason: string;
  actorUserId: string | null;
  actorUserName: string | null;
  actorRole: string | null;
}

export interface CreatedOverride {
  token: string;        // UUID — caller forwards this on PUT body
  expiresAt: string;    // ISO 8601 UTC — surfaced to FE for display
}

/**
 * Insert a fresh override row and return the UUID + expiry. Caller is
 * responsible for the eligibility re-check (status, JC completion,
 * production_window) BEFORE calling this — we don't second-guess here.
 */
export async function createEditLockOverride(
  db: D1Database,
  params: CreateOverrideParams,
): Promise<CreatedOverride> {
  const token = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + OVERRIDE_TOKEN_TTL_MS).toISOString();

  await db
    .prepare(
      `INSERT INTO edit_lock_overrides (
         id, orderType, orderId, reason,
         actorUserId, actorUserName, actorRole,
         createdAt, expiresAt, usedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      token,
      params.orderType,
      params.orderId,
      params.reason,
      params.actorUserId,
      params.actorUserName,
      params.actorRole,
      createdAt,
      expiresAt,
    )
    .run();

  return { token, expiresAt };
}

export type ConsumeOverrideResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "wrong_order" | "expired" | "already_used" };

/**
 * Verify the override token matches the (orderType, orderId), is unexpired,
 * and unused — then atomically stamp used_at. Returns ok:true if the PUT
 * is allowed to skip the production_window check; otherwise ok:false with
 * a discriminator the caller can map to a specific error message.
 *
 * The UPDATE...WHERE used_at IS NULL clause guarantees single-use semantics
 * even under concurrent PUTs — only one query will report changes>0, the
 * loser sees changes=0 and falls into already_used.
 */
export async function consumeEditLockOverrideToken(
  db: D1Database,
  token: string,
  orderType: EditLockOrderType,
  orderId: string,
): Promise<ConsumeOverrideResult> {
  const row = await db
    .prepare(
      `SELECT id, orderType, orderId, expiresAt, usedAt
         FROM edit_lock_overrides
        WHERE id = ?
        LIMIT 1`,
    )
    .bind(token)
    .first<{
      id: string;
      orderType: string;
      orderId: string;
      expiresAt: string;
      usedAt: string | null;
    }>();

  if (!row) return { ok: false, reason: "not_found" };
  if (row.orderType !== orderType || row.orderId !== orderId) {
    return { ok: false, reason: "wrong_order" };
  }
  if (row.usedAt) return { ok: false, reason: "already_used" };
  const nowIso = new Date().toISOString();
  if (row.expiresAt <= nowIso) return { ok: false, reason: "expired" };

  // Atomic single-use stamp. The "AND usedAt IS NULL" guard is what makes
  // this race-safe: a second concurrent PUT that read the same NULL will
  // find this UPDATE has already flipped it and report changes=0.
  const upd = await db
    .prepare(
      `UPDATE edit_lock_overrides
          SET usedAt = ?
        WHERE id = ?
          AND usedAt IS NULL`,
    )
    .bind(nowIso, token)
    .run();

  // D1 returns meta.changes; supabase-compat normalises to .meta.changes too.
  const changes =
    (upd as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes < 1) return { ok: false, reason: "already_used" };
  return { ok: true };
}

/**
 * Best-effort displayName lookup. Returns null on any failure rather than
 * blocking the override — the row is still useful with just actorUserId.
 * Mirrors the pattern in src/api/lib/audit.ts emitAudit().
 */
export async function lookupActorDisplayName(
  db: D1Database,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const row = await db
      .prepare("SELECT displayName FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ displayName: string | null }>();
    return row?.displayName ?? null;
  } catch {
    return null;
  }
}
