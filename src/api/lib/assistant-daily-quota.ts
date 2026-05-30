// ---------------------------------------------------------------------------
// assistant-daily-quota.ts — per-user daily cap on AI Assistant questions.
//
// Why this exists: every /api/assistant/chat question is a full Anthropic
// Messages call plus a multi-step tool loop (up to MAX_ITERATIONS follow-up
// calls). Worst case a single question costs RM 0.5–1. Without a ceiling a
// curious operator (or a runaway client retry) could quietly run up a large
// daily bill. Wei Siang asked for a hard cap of 10 questions per person per
// day — INCLUDING himself (the SUPER_ADMIN) — to bound worst-case spend.
//
// Design (mirrors api-rate-limit.ts):
//   * One fixed daily bucket per user, keyed by the Singapore calendar day
//     (UTC+8). The factory and all operators are in SGT, so "resets at
//     midnight" means SGT midnight, not UTC.
//   * Counter stored in SESSION_CACHE KV (same binding as auth + the other
//     limiters). Read on the CHECK, single write on the INCREMENT.
//   * Best-effort / fail-open: any KV failure (binding missing in test env,
//     transient blip) ALLOWS the question. We never want a KV outage to lock
//     the operator out of the assistant. Over-counting is the safe direction
//     for a spend cap, but locking everyone out is not.
//   * The CHECK happens early (before we ingest attachments or call Anthropic)
//     and the INCREMENT happens once, right before we open the model stream,
//     so a question only counts when it actually reaches the model.
//
// The pure helpers (getDailyLimit / sgtDayKey / secondsUntilSgtMidnight) take
// no KV and are unit-tested in tests/assistant-daily-quota.test.mjs.
// ---------------------------------------------------------------------------

// Minimal shape of the KV binding we touch — avoids importing the full
// Cloudflare Workers types into a file that's also loaded by the Node test
// runner under tsx.
type KvLike = {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
};

// Singapore is UTC+8 with no daylight saving, so a fixed offset is correct
// year-round.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

const KEY_PREFIX = "aiquota:";

// Keep the bucket around for two days so a question asked just before SGT
// midnight and one just after never collide, and so the previous day's count
// is still readable for a short grace window if clocks drift. KV reclaims it
// automatically after this.
const BUCKET_TTL_SECONDS = 172_800; // 48h

const DEFAULT_DAILY_LIMIT = 10;

/**
 * Resolve the configured per-user daily limit.
 *
 * Reads `ASSISTANT_DAILY_LIMIT` (a string env var so it can be a plain
 * wrangler [var]). Falls back to {@link DEFAULT_DAILY_LIMIT} when unset,
 * blank, or not a non-negative integer. A value of 0 means "no cap" — the
 * caller should skip the check entirely.
 */
export function getDailyLimit(env: { ASSISTANT_DAILY_LIMIT?: string }): number {
  const raw = env.ASSISTANT_DAILY_LIMIT;
  if (raw == null || raw.trim() === "") return DEFAULT_DAILY_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_LIMIT;
  return n;
}

/**
 * The Singapore calendar day for `now`, as "YYYY-MM-DD". This is the bucket
 * key suffix — every question on the same SGT day shares one counter, and the
 * counter naturally "resets" when the SGT date rolls over.
 */
export function sgtDayKey(now: number): string {
  // Shift into SGT, then read the UTC fields of the shifted instant — those
  // now read as the SGT wall-clock date.
  const shifted = new Date(now + SGT_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Seconds remaining until the next SGT midnight — used as the Retry-After
 * hint when a user is over the cap, so the client knows when their quota
 * resets. Always returns at least 1 (never 0 or negative).
 */
export function secondsUntilSgtMidnight(now: number): number {
  const shifted = now + SGT_OFFSET_MS;
  const msIntoDay = ((shifted % 86_400_000) + 86_400_000) % 86_400_000;
  const msLeft = 86_400_000 - msIntoDay;
  return Math.max(1, Math.ceil(msLeft / 1000));
}

/** Build the KV key for a user's counter on the SGT day containing `now`. */
function quotaKey(userId: string, now: number): string {
  const sanitised = userId.replace(/[^a-zA-Z0-9._@:-]/g, "_");
  return `${KEY_PREFIX}${sanitised}:${sgtDayKey(now)}`;
}

/**
 * Read-only: how many questions this user has already used today (SGT).
 * Returns 0 on any KV miss or error — fail-open, never blocks on KV trouble.
 */
export async function getDailyUsage(
  kv: KvLike | undefined,
  userId: string,
  now: number,
): Promise<number> {
  if (!kv) return 0;
  try {
    const v = await kv.get(quotaKey(userId, now));
    if (!v) return 0;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (e) {
    console.warn("[assistant-daily-quota] KV read failed, allowing:", e);
    return 0;
  }
}

/**
 * Increment the user's daily counter and return the new value. Best-effort:
 * if the KV write fails we still return the optimistic count so the caller
 * can proceed (fail-open). KV eventual consistency means concurrent questions
 * can under-count slightly — acceptable for a spend cap.
 */
export async function bumpDailyUsage(
  kv: KvLike | undefined,
  userId: string,
  now: number,
): Promise<number> {
  if (!kv) return 0;
  const key = quotaKey(userId, now);
  let current = 0;
  try {
    const v = await kv.get(key);
    if (v) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) current = n;
    }
  } catch (e) {
    console.warn("[assistant-daily-quota] KV read-before-bump failed:", e);
  }
  const next = current + 1;
  try {
    await kv.put(key, String(next), { expirationTtl: BUCKET_TTL_SECONDS });
  } catch (e) {
    console.warn("[assistant-daily-quota] KV write failed:", e);
  }
  return next;
}
