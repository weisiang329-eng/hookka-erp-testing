// ---------------------------------------------------------------------------
// verifiedSave — write + readback + compare + honest result.
//
// Wei Siang 2026-05-25 ask: "If I save successfully, it should only tell me
// successful when it actually saved. Not from backend's 200 response —
// because if cache is stale / write half-applied / network dropped on the
// response, the FE shows green checkmark but the data didn't actually
// persist. We hit this with batch Apply PIC: backend wrote, but the
// snapshot cache served the pre-write payload, the FE optimistic update
// got silently overwritten, and the operator saw success-then-fail."
//
// This helper enforces the discipline: any caller that needs "I'm telling
// the operator it saved" must route through here. It will:
//
//   1. Send the mutating request (POST / PUT / PATCH / DELETE).
//   2. On 2xx, immediately READ BACK the affected resource via the
//      caller-supplied `readback` function (which MUST bypass any FE cache
//      — pass a cache-bust query param or use a direct fetch).
//   3. Compare the readback against the `expect` map (what the caller
//      asked the backend to write). For each key, the readback value must
//      equal the expected value.
//   4. Return one of:
//        { ok: true,  data }                              ← honest success
//        { ok: false, reason: 'http',     status, body }  ← server rejected
//        { ok: false, reason: 'network',  details }       ← unreachable
//        { ok: false, reason: 'mismatch', diffs }         ← cache/stale-write
//
// The caller decides what to do with each branch — typical pattern:
//
//   const result = await verifiedSave({...});
//   if (result.ok) {
//     toast.success("Saved");
//   } else if (result.reason === 'mismatch') {
//     toast.error(`Save did NOT take effect. ${result.diffs[0].field}: tried
//                  ${result.diffs[0].expected}, server returned ${result.diffs[0].actual}.
//                  Please try again or refresh.`);
//   } else {
//     toast.error(`Save failed: ${result.details}`);
//   }
//
// The mismatch branch is the load-bearing one — it catches the bug class
// where everything LOOKED green but the persisted state lied.
//
// Performance: adds one extra GET per save. Typical cost is 50-200ms over
// the existing fetch (the GET hits the snapshot cache after invalidation
// or a thin no-cache endpoint). Hookka's save frequency is operator-
// driven (a few per minute peak), so the round-trip is acceptable.
// ---------------------------------------------------------------------------

import { csrfHeaders } from "./csrf";

type SaveResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "http"; status: number; body: string }
  | { ok: false; reason: "network"; details: string }
  | {
      ok: false;
      reason: "mismatch";
      diffs: Array<{ field: string; expected: unknown; actual: unknown }>;
      data: T;
    };

export type VerifiedSaveArgs<T> = {
  /** Endpoint URL + method + body for the mutation. */
  endpoint: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Additional headers such as Idempotency-Key for money/document writes. */
  headers?: Record<string, string>;
  /**
   * Readback function called after the mutation succeeds. MUST bypass any
   * caller-side cache (e.g. a fresh `fetch` with `cache: "no-store"` and a
   * cache-bust query param). The returned value is what we compare against
   * `expect`. If readback throws or returns null, that's a `network`
   * failure — operator gets told the save state is unknown.
   */
  readback: () => Promise<T | null>;
  /**
   * Map of field-name → expected value. Each key MUST exist on the readback
   * object. For nested fields (e.g. `jobCards[0].pic1Id`), the caller
   * should flatten or supply an accessor instead — keep this helper
   * shallow on purpose so the mismatch branch's error message stays
   * readable.
   */
  expect: Record<string, unknown>;
};

export async function verifiedSave<T>(args: VerifiedSaveArgs<T>): Promise<SaveResult<T>> {
  // ── 1. Send the mutation ────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(args.endpoint, {
      method: args.method,
      headers: { ...csrfHeaders(), ...(args.headers ?? {}) },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      credentials: "include",
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      details: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable */
    }
    return { ok: false, reason: "http", status: res.status, body };
  }

  // ── 2. Read back ────────────────────────────────────────────────────────
  let data: T | null;
  try {
    data = await args.readback();
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      details: `readback failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (data == null) {
    return {
      ok: false,
      reason: "network",
      details: "readback returned null/undefined — resource not found after save",
    };
  }

  // ── 3. Compare ──────────────────────────────────────────────────────────
  const diffs: Array<{ field: string; expected: unknown; actual: unknown }> = [];
  for (const [field, expected] of Object.entries(args.expect)) {
    const actual = (data as Record<string, unknown>)[field];
    // An ARRAY of expected values means "one of" — pass when the actual matches
    // any of them. Used for transitions that legitimately settle on more than
    // one valid end-state: e.g. marking a DO DELIVERED auto-creates its invoice
    // and immediately bumps it to INVOICED, so both DELIVERED and INVOICED are
    // a successful delivery. Otherwise it's an exact (loose) match.
    // Normalise null/undefined/"" so a backend that returns "" for a cleared
    // field doesn't trip the comparison when caller expected null.
    const ok = Array.isArray(expected)
      ? expected.some((e) => equalLoose(actual, e))
      : equalLoose(actual, expected);
    if (!ok) {
      diffs.push({ field, expected, actual });
    }
  }
  if (diffs.length > 0) {
    return { ok: false, reason: "mismatch", diffs, data };
  }

  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// verifiedBulkSave — same idea for batch endpoints that touch N items.
//
// The mutation goes through once; the readback runs ONCE and returns an
// array (the caller's job to fetch the affected resource list with a
// cache-bust). Per-item expectations are checked individually so the error
// message can name exactly which row failed.
// ---------------------------------------------------------------------------
export type VerifiedBulkSaveArgs<TItem> = {
  endpoint: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  readback: () => Promise<TItem[]>;
  /**
   * For each expected item, supply:
   *   - `id`     — how to find this item in the readback array
   *   - `expect` — fields to compare on that item
   */
  expect: Array<{
    id: string;
    findBy: (item: TItem) => boolean;
    fields: Record<string, unknown>;
  }>;
};

type BulkSaveResult<TItem> =
  | { ok: true; data: TItem[] }
  | { ok: false; reason: "http"; status: number; body: string }
  | { ok: false; reason: "network"; details: string }
  | {
      ok: false;
      reason: "mismatch";
      perItemDiffs: Array<{
        id: string;
        diffs: Array<{ field: string; expected: unknown; actual: unknown }>;
      }>;
      missing: string[];
      data: TItem[];
    };

export async function verifiedBulkSave<TItem>(
  args: VerifiedBulkSaveArgs<TItem>,
): Promise<BulkSaveResult<TItem>> {
  let res: Response;
  try {
    res = await fetch(args.endpoint, {
      method: args.method,
      headers: csrfHeaders(),
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      credentials: "include",
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      details: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable */
    }
    return { ok: false, reason: "http", status: res.status, body };
  }

  let data: TItem[];
  try {
    data = await args.readback();
  } catch (err) {
    return {
      ok: false,
      reason: "network",
      details: `readback failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const perItemDiffs: Array<{
    id: string;
    diffs: Array<{ field: string; expected: unknown; actual: unknown }>;
  }> = [];
  const missing: string[] = [];

  for (const expectedItem of args.expect) {
    const actualItem = data.find(expectedItem.findBy);
    if (!actualItem) {
      missing.push(expectedItem.id);
      continue;
    }
    const diffs: Array<{ field: string; expected: unknown; actual: unknown }> = [];
    for (const [field, expected] of Object.entries(expectedItem.fields)) {
      const actual = (actualItem as Record<string, unknown>)[field];
      if (!equalLoose(actual, expected)) {
        diffs.push({ field, expected, actual });
      }
    }
    if (diffs.length > 0) {
      perItemDiffs.push({ id: expectedItem.id, diffs });
    }
  }

  if (perItemDiffs.length > 0 || missing.length > 0) {
    return {
      ok: false,
      reason: "mismatch",
      perItemDiffs,
      missing,
      data,
    };
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// equalLoose — treat null / undefined / "" as the same when comparing
// what we wrote vs what came back. The backend normalises empty fields
// inconsistently (some return "", some null) and we don't want a mismatch
// toast triggered by that. Operator-visible meaning is the same: "the
// field is empty".
//
// Zero money is folded into the same "empty" bucket (BUG-2026-06-12): a
// 0-amount field (e.g. an invoice line/total zeroed for a free service
// order) comes back from the backend as null/"" sometimes and 0 other
// times, which would false-trip the guard ("Save did NOT take effect —
// tried 0, system has (empty)") even though the write succeeded. 0 and
// empty mean the same to the operator: "no amount". A real mismatch (tried
// 0, got a non-zero value, or vice-versa) is still caught, because only the
// zero/empty pair collapses.
// ---------------------------------------------------------------------------
function equalLoose(a: unknown, b: unknown): boolean {
  const isZeroish = (v: unknown) =>
    v === 0 || (typeof v === "string" && /^0+(\.0+)?$/.test(v.trim()));
  const norm = (v: unknown) =>
    v === null || v === undefined || v === "" || isZeroish(v) ? null : v;
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Date strings sometimes come back with timezone; normalise to date-only
  // for the YYYY-MM-DD case.
  if (typeof na === "string" && typeof nb === "string") {
    const dateRe = /^\d{4}-\d{2}-\d{2}/;
    if (dateRe.test(na) && dateRe.test(nb)) {
      return na.slice(0, 10) === nb.slice(0, 10);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// formatMismatchError — humanise a mismatch diff for a toast message.
// Operator language only — no field-name jargon if avoidable. Caller can
// override by reading result.diffs directly.
// ---------------------------------------------------------------------------
export function formatMismatchError(diffs: Array<{ field: string; expected: unknown; actual: unknown }>): string {
  if (diffs.length === 0) return "Save did not take effect.";
  const first = diffs[0];
  const more = diffs.length > 1 ? ` (+${diffs.length - 1} more)` : "";
  return `Save did NOT take effect — ${first.field}: tried ${stringify(first.expected)}, system has ${stringify(first.actual)}${more}. Please try again.`;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
