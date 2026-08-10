// ---------------------------------------------------------------------------
// humanize-error.ts — turn ANY thrown error / failed-response into a short,
// plain-English line that is safe to show a factory-floor operator.
//
// Owner directive (2026-06-08): the ERP must NEVER show operators an HTTP
// status code, a raw backend exception string, a database field/column name,
// or JS stack noise. Everything user-facing must read as plain language.
//
// This is the DISPLAY translator. It does NOT destroy technical detail — the
// underlying error keeps its .status/.url/.body, and callers/loggers can still
// inspect those (and report to Sentry). humanizeError only decides what TEXT
// the human sees:
//
//   1. If the error carries a CLEAN, human-readable message (a friendly
//      backend message like "Order already confirmed"), keep it — that is the
//      best UX and the backend authored it on purpose.
//   2. If the message looks TECHNICAL (HTTP code, our internal fetch strings,
//      postgres/constraint text, a DB column name, a JS TypeError, a stack
//      frame, a bare URL), drop it and use a friendly line — by HTTP status
//      when we know it, by the caller's context fallback, else a generic line.
//
// Pure + exported so the classification is unit-tested.
// ---------------------------------------------------------------------------

const GENERIC = "Something went wrong. Please try again.";

// Friendly, actionable line per HTTP status. Returns null for statuses we have
// no specific wording for (caller fallback / generic line then applies).
function messageForStatus(status: number): string | null {
  if (status === 0)
    return "Network problem — please check your connection and try again.";
  if (status === 401 || status === 403)
    return "You're not allowed to do that. Try signing in again.";
  if (status === 404)
    return "That item couldn't be found — it may have been removed.";
  if (status === 408 || status === 504)
    return "That took too long. Please try again.";
  if (status === 409)
    return "This couldn't be done — the item was changed or is still linked to other records.";
  if (status === 413) return "That file or request is too large.";
  if (status === 429)
    return "Too many requests — please wait a moment and try again.";
  if (status >= 500)
    return "Something went wrong on our side. Please try again in a moment.";
  if (status === 400 || status === 422)
    return "Some details aren't valid — please check them and try again.";
  return null;
}

// Statuses whose friendly line is MORE useful than a caller's generic fallback
// (so we prefer the status line even when the caller passed a fallback).
const SPECIFIC_STATUSES = new Set([401, 403, 404, 409, 413, 429]);

// Patterns that mark a string as internal/technical → never show it. Kept
// CONSERVATIVE: this runs on EVERY error toast (incl. legit messages that may
// contain numbers like "Order #500" or words like "Failed to load orders"), so
// the patterns are specific enough not to flag a clean human sentence.
const TECHNICAL =
  /(\bHTTP\s*\d{3}\b|\b\d{3}\s+from\s+\/|Invalid JSON from|did not match schema|Network error while requesting|Request timeout after|\bNOT NULL\b|null value in column|violates \w+ constraint|violates unique|duplicate key value|foreign key constraint|syntax error at|relation "\w+"|column "\w+"|is not a function|cannot read propert|is not defined|unexpected token|\.[jt]sx?:\d+:\d+|\bTypeError\b|\bReferenceError\b|ECONNREFUSED|ETIMEDOUT)/i;

export function looksTechnical(msg: string): boolean {
  const m = msg.trim();
  if (!m) return true;
  if (TECHNICAL.test(m)) return true;
  // A bare token with an underscore or dot and no spaces → likely a DB column
  // / identifier (vehicle_id, job_cards.pic1Id) rather than a sentence.
  if (!/\s/.test(m) && /[_.]/.test(m)) return true;
  // Contains a URL or an /api/ path.
  if (/https?:\/\/|\/api\//i.test(m)) return true;
  return false;
}

type ErrLike = { status?: unknown; message?: unknown; error?: unknown };

function extract(err: unknown): { status?: number; candidate: string } {
  let status: number | undefined;
  let candidate = "";
  if (typeof err === "string") {
    candidate = err;
  } else if (err && typeof err === "object") {
    const e = err as ErrLike;
    if (typeof e.status === "number") status = e.status;
    candidate =
      typeof e.message === "string"
        ? e.message
        : typeof e.error === "string"
          ? e.error
          : "";
  }
  // Recover a status the error object didn't carry but its text reveals — e.g.
  // a raw `throw new Error("HTTP 500 ...")` (swr-fetcher) or "503 from /api/x",
  // or the browser's own network-failure message ("Failed to fetch").
  if (status === undefined && candidate) {
    const m = candidate.match(/\bHTTP\s*(\d{3})\b|\b(\d{3})\s+from\s+\//i);
    if (m) {
      status = Number(m[1] ?? m[2]);
    } else if (
      // EXACT browser network-failure messages (anchored, so a legit
      // "Failed to fetch the report" is NOT swallowed). Blank the candidate so
      // it routes to the friendly network line instead of being shown as-is.
      /^(TypeError:\s*)?(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(
        candidate.trim(),
      )
    ) {
      status = 0;
      candidate = "";
    }
  }
  return { status, candidate };
}

/**
 * Translate an error into a plain-English, operator-safe message.
 *
 * @param err      anything thrown/caught (Error, FetchJsonError, string, …)
 * @param fallback caller context shown when there's no clean message and no
 *                 specific status line — e.g. "Couldn't save the order".
 */
export function humanizeError(err: unknown, fallback?: string): string {
  const { status, candidate } = extract(err);

  // 1. A clean, human backend message is the best thing to show.
  if (candidate && !looksTechnical(candidate)) return candidate.trim();

  // 2. Specific, actionable status lines beat a generic caller fallback.
  if (status !== undefined && SPECIFIC_STATUSES.has(status)) {
    const s = messageForStatus(status);
    if (s) return s;
  }

  // 3. Caller's plain context fallback ("Couldn't create the product").
  if (fallback && fallback.trim()) return fallback.trim();

  // 4. Any remaining known status → its friendly line.
  if (status !== undefined) {
    const s = messageForStatus(status);
    if (s) return s;
  }

  // 5. Last resort.
  return GENERIC;
}

/**
 * SERVER-SIDE twin of rule 1 above: decide what a route's catch-all is allowed
 * to put in `{ success: false, error }`.
 *
 * A route that returns `err.message` raw ships whatever Postgres said straight
 * to the operator's toast — that is how a shop-floor user came to be shown
 * `production_orders_product_id_fkey` (2026-08-10). Worse, `humanizeError` on
 * the client then correctly classifies it as technical and replaces it with
 * "Something went wrong. Please try again.", which tells the user nothing AND
 * hides the real cause: the toast is generic precisely because the message was
 * unusable. So the fix has to be at the source.
 *
 * Deliberately message-preserving: a route that threw a hand-written sentence
 * ("Order already confirmed") keeps it. Only text that `looksTechnical`
 * rejects is swapped for the caller's plain fallback. The real error is still
 * logged server-side — nothing is lost, only what the human reads changes.
 */
export function operatorSafeError(err: unknown, fallback: string): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  return raw && !looksTechnical(raw) ? raw.trim() : fallback;
}
