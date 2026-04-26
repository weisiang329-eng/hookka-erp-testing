// ---------------------------------------------------------------------------
// W3C Trace Context — browser-side traceparent generator (P6.1).
//
// Format (per https://www.w3.org/TR/trace-context/#traceparent-header):
//   00-{trace_id_32hex}-{span_id_16hex}-{flags_2hex}
//   ^^ version           ^^ span (per fetch)        ^^ 01 = sampled
//      ^^ trace (sticky for the page session)
//
// Strategy:
//   - `trace_id` is generated once per page session and persisted in
//     sessionStorage so every fetch from this tab shares one trace.
//   - `span_id` is freshly minted per fetch — that's what the worker logs
//     alongside the trace_id so a single trace is reconstructable from
//     logs.
//   - Sampling: 100% in dev (so the local devtools/wrangler tail surface
//     every fetch) and 1% in prod. The unsampled flag still propagates the
//     IDs (flags=00) so a downstream collector COULD sample them; today the
//     worker just gates whether to log the line.
//
// Failure mode: if sessionStorage is unavailable (incognito, disabled), we
// fall back to a per-fetch random trace — slightly less useful but still
// emits a valid header. Cache is best-effort, never load-bearing.
// ---------------------------------------------------------------------------

const TRACE_ID_KEY = "hookka-trace-id:v1";
const TRACE_VERSION = "00";
const FLAG_SAMPLED = "01";
const FLAG_UNSAMPLED = "00";

// Sampling rate in production. 1/100 fetches get flag=01 (sampled).
// In dev (import.meta.env.DEV) we bump this to 1.0 so every request shows
// up in wrangler tail / devtools without per-run config.
const PROD_SAMPLE_RATE = 0.01;

function isDev(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

function randomHex(byteLen: number): string {
  // Use crypto.getRandomValues if available — Math.random is good enough
  // for a span_id but the trace_id should not collide across tabs, so a
  // CSPRNG is the safer default.
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buf = new Uint8Array(byteLen);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Math.random fallback — Workers / modern browsers always have crypto, so
  // this is mostly here for SSR / unit-test environments.
  let out = "";
  for (let i = 0; i < byteLen; i++) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Read (or mint + persist) the per-page-session trace_id. Always returns a
 * 32-char lowercase hex string. Falls back to a fresh random id if
 * sessionStorage is unavailable, so the function never throws.
 */
export function getOrCreateTraceId(): string {
  if (typeof window === "undefined") return randomHex(16);
  try {
    const existing = window.sessionStorage.getItem(TRACE_ID_KEY);
    if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
    const fresh = randomHex(16);
    window.sessionStorage.setItem(TRACE_ID_KEY, fresh);
    return fresh;
  } catch {
    return randomHex(16);
  }
}

/**
 * Build a fresh `traceparent` header value for a single fetch.
 *
 * - `trace_id` reuses the per-page-session id so the worker can stitch all
 *   requests from one tab into one trace.
 * - `span_id` is minted per call.
 * - `flags` is 01 (sampled) in dev or with PROD_SAMPLE_RATE probability in
 *   prod. The header is ALWAYS present — sampling is an instruction to the
 *   collector, not a reason to omit propagation.
 */
export function buildTraceparent(): string {
  const traceId = getOrCreateTraceId();
  const spanId = randomHex(8);
  const sampled = isDev() || Math.random() < PROD_SAMPLE_RATE;
  const flags = sampled ? FLAG_SAMPLED : FLAG_UNSAMPLED;
  return `${TRACE_VERSION}-${traceId}-${spanId}-${flags}`;
}
