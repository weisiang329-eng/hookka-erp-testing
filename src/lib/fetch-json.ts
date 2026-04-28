// ---------------------------------------------------------------------------
// fetchJson — typed API boundary with runtime validation.
//
// Why this exists: `await res.json()` returns `any`. Code writes
// `as Foo[]` to silence TS, but the runtime shape can be anything —
// especially when mock/stub/D1 routes return different envelopes. Shape drift
// silently poisons state and trips up `.filter` / `.map` / `.length` deep in
// render, producing "Something went wrong" with no clean error.
//
// fetchJson<T> runs the parsed body through a Zod schema. Mismatch throws a
// FetchJsonError the caller can render or swallow — never `undefined.foo`.
//
// Usage:
//   const CustomerList = z.object({ success: z.boolean(), data: z.array(Customer) });
//   const { data } = await fetchJson("/api/customers", CustomerList);
//
// Or for endpoints that return a bare array OR an envelope:
//   const list = await fetchJson("/api/forecasts", arrayOrEnvelope(Forecast));
// ---------------------------------------------------------------------------
import { z } from "zod";
import { buildTraceparent } from "./trace";
import { readCsrfCookie } from "./csrf";

export class FetchJsonError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly body?: unknown;
  public readonly zodIssues?: z.ZodIssue[];

  constructor(
    message: string,
    status: number,
    url: string,
    body?: unknown,
    zodIssues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = "FetchJsonError";
    this.status = status;
    this.url = url;
    this.body = body;
    this.zodIssues = zodIssues;
  }
}

type FetchJsonInit = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * @deprecated Sprint 7 moved auth to a HttpOnly cookie that the browser
   * attaches automatically — there is no token to skip. Kept on the type so
   * existing call sites compile; the value is ignored.
   */
  noAuth?: boolean;
  /** Request timeout in ms (defaults to 15000). */
  timeoutMs?: number;
};

const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Fetch + JSON-parse + schema-validate in one call. Always returns the parsed
 * + validated `z.infer<TSchema>` or throws a FetchJsonError.
 */
export async function fetchJson<TSchema extends z.ZodTypeAny>(
  url: string,
  schema: TSchema,
  init: FetchJsonInit = {},
): Promise<z.infer<TSchema>> {
  const { timeoutMs = 15_000, signal: upstreamSignal, ...restInit } = init;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // P6.1 — W3C Trace Context. One header per fetch; trace_id is sticky
    // for the page session so the worker can join requests on one trace.
    // Caller-supplied headers can still override (last-write-wins below).
    traceparent: buildTraceparent(),
    ...(restInit.headers ?? {}),
  };
  // Sprint 7: dashboard auth lives in a HttpOnly cookie the browser attaches
  // automatically with `credentials: 'include'`. For mutating methods we
  // also echo the CSRF cookie value into X-CSRF-Token (double-submit pattern
  // — server enforces match in auth-middleware.ts). Caller-supplied
  // X-CSRF-Token wins so tests can pass an explicit value.
  const method = (restInit.method || "GET").toUpperCase();
  if (CSRF_METHODS.has(method) && !headers["x-csrf-token"]) {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  const ctrl = new AbortController();
  const timeoutId = globalThis.setTimeout(() => ctrl.abort(), timeoutMs);
  const onUpstreamAbort = () => ctrl.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) ctrl.abort();
    else upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...restInit,
      // Sprint 7: ensure the session + CSRF cookies travel with every API
      // request. Same-origin defaults to `same-origin`, but being explicit
      // also makes things work behind a Pages-functions custom domain
      // where the API origin sometimes differs.
      credentials: restInit.credentials ?? "include",
      signal: ctrl.signal,
      headers,
      body:
        restInit.body === undefined
          ? undefined
          : typeof restInit.body === "string"
            ? restInit.body
            : JSON.stringify(restInit.body),
    });
  } catch {
    const timedOut = ctrl.signal.aborted && !(upstreamSignal?.aborted);
    const msg = timedOut
      ? `Request timeout after ${timeoutMs}ms: ${url}`
      : `Network error while requesting ${url}`;
    throw new FetchJsonError(msg, 0, url, undefined);
  } finally {
    globalThis.clearTimeout(timeoutId);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", onUpstreamAbort);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new FetchJsonError(
      `Invalid JSON from ${url}`,
      res.status,
      url,
      undefined,
    );
  }

  if (!res.ok) {
    const msg =
      (raw as { error?: string })?.error ?? `HTTP ${res.status} from ${url}`;
    throw new FetchJsonError(msg, res.status, url, raw);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (import.meta.env.DEV) {
      console.error(`[fetchJson] schema mismatch at ${url}`, {
        issues: parsed.error.issues,
        raw,
      });
    }
    throw new FetchJsonError(
      `Response shape from ${url} did not match schema`,
      res.status,
      url,
      raw,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

// -----------------------------------------------------------------------------
// Envelope helpers — most endpoints follow one of a handful of shapes, so we
// prebuild schemas for them instead of making every caller re-declare.
// -----------------------------------------------------------------------------

/** `{ success: boolean, data: z.infer<T> }` — the D1 convention. */
export function envelope<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.boolean().optional(),
    data,
    total: z.number().optional(),
    _stub: z.boolean().optional(),
  });
}

/**
 * For list endpoints that might return a bare array OR an envelope with
 * `.data` as the array. Always yields `TItem[]`.
 */
export function arrayOrEnvelope<TItem extends z.ZodTypeAny>(item: TItem) {
  return z
    .union([
      z.array(item),
      z.object({
        success: z.boolean().optional(),
        data: z.array(item),
        total: z.number().optional(),
        _stub: z.boolean().optional(),
      }),
    ])
    .transform((v) => (Array.isArray(v) ? v : v.data));
}

/** Loose pass-through: accept anything, return it untyped. Last-resort escape. */
export const passthrough = z.unknown();
