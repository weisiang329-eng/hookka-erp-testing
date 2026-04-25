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
import { getAuthToken } from "./auth";

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
  /** Skip attaching the bearer token even if one exists. */
  noAuth?: boolean;
};

/**
 * Fetch + JSON-parse + schema-validate in one call. Always returns the parsed
 * + validated `z.infer<TSchema>` or throws a FetchJsonError.
 */
export async function fetchJson<TSchema extends z.ZodTypeAny>(
  url: string,
  schema: TSchema,
  init: FetchJsonInit = {},
): Promise<z.infer<TSchema>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers ?? {}),
  };
  if (!init.noAuth) {
    const token = getAuthToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...init,
    headers,
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  });

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
      // eslint-disable-next-line no-console
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
