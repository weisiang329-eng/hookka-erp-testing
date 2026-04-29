// ---------------------------------------------------------------------------
// Supabase Storage helper — replaces the previous Cloudflare R2 wrapper
// (r2-store.ts) as part of the storage-supabase-migration refactor.
//
// Why Supabase Storage instead of R2:
//   We're already paying for Supabase Pro (Postgres, Auth, Realtime). The
//   plan includes 100 GB object storage and 250 GB egress/month — more than
//   enough headroom for the daily pg_dump (~5 GB/mo) and file attachments
//   (~3 GB/mo). Folding storage into the same vendor cuts the operational
//   surface and removes the Cloudflare R2 API token rotation burden.
//
// API surface (kept identical to the old R2 helper so callers don't need
// to change shape — only the import path):
//   * putFile(env, bucket, key, body, contentType)        → uploads, returns key
//   * getFile(env, bucket, key)                            → fetches the body
//   * signedDownloadUrl(env, bucket, key, ttlSeconds=300)  → presigned URL
//   * deleteFile(env, bucket, key)                         → removes the object
//   * listFiles(env, bucket, prefix, limit=1000)           → list under prefix
//
// Auth contract:
//   The Worker authenticates against Supabase Storage using the
//   service_role key (env.SUPABASE_SERVICE_KEY). This key is server-only
//   — NEVER ship it to the SPA bundle. Set via `wrangler secret put
//   SUPABASE_SERVICE_KEY`. The project ref (env.SUPABASE_PROJECT_REF) is
//   public; it's the slug in the supabase.co URL.
//
// Bucket bootstrap:
//   Supabase Storage requires the bucket to exist before any upload.
//   Create it once via the Supabase Dashboard → Storage → New bucket
//   (name: "hookka-files", public: false). This runbook step lives in
//   docs/DR-RUNBOOK.md (Storage bootstrap section).
//
// Security notes:
//   * Signed URLs use the Supabase Storage v1 sign endpoint (no aws-sdk,
//     no extra deps). TTL defaults to 5 minutes — long enough for the
//     browser to follow a 302 redirect, short enough that a leaked URL
//     is harmless.
//   * Keys MUST be opaque random ids prefixed by orgId/resourceType/
//     resourceId so a brute-force walk of the bucket can't surface
//     attachments belonging to another tenant. The route layer
//     (routes/files.ts) is responsible for stamping the prefix.
// ---------------------------------------------------------------------------

/**
 * Minimal env contract — kept local so this module doesn't depend on
 * the full Hono Env type. The route layer can pass `c.env` directly.
 */
type SupabaseStorageEnv = {
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_SERVICE_KEY?: string;
};

/**
 * Thrown when a route calls into supabase-storage but the credentials
 * are not configured. Callers should map this to a 503 Service
 * Unavailable; do NOT log the raw key to clients.
 */
export class SupabaseStorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Supabase Storage not configured — set SUPABASE_PROJECT_REF + SUPABASE_SERVICE_KEY (see docs/DR-RUNBOOK.md)",
    );
    this.name = "SupabaseStorageNotConfiguredError";
  }
}

/**
 * Backwards-compatible alias for callers that still catch
 * `R2BucketNotConfiguredError`. The error class itself was renamed to
 * `SupabaseStorageNotConfiguredError`; this re-export lets the route
 * layer migrate at its own pace.
 */
export const R2BucketNotConfiguredError = SupabaseStorageNotConfiguredError;

function requireConfig(env: SupabaseStorageEnv): {
  projectRef: string;
  serviceKey: string;
} {
  if (!env.SUPABASE_PROJECT_REF || !env.SUPABASE_SERVICE_KEY) {
    throw new SupabaseStorageNotConfiguredError();
  }
  return {
    projectRef: env.SUPABASE_PROJECT_REF,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  };
}

function storageBaseUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co/storage/v1`;
}

/**
 * Default bucket — keeps the public API drop-in compatible with the old
 * R2 helper (which had a single `FILES` binding). Callers that want to
 * use a different bucket can call the explicit overloads.
 */
export const DEFAULT_BUCKET = "hookka-files";

// Encode each path segment but keep the slashes — Supabase nests folders
// inside the object name and we want the on-disk hierarchy preserved.
function encodeObjectPath(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Subset of the @supabase/storage-js StorageObject shape that we actually
 * use. The /list response returns more fields than this; we just don't
 * touch them.
 */
export interface StorageObject {
  /** Object name as Supabase stores it (NOT including the bucket prefix). */
  key: string;
  /** Object size in bytes (best-effort — Supabase populates this from `metadata.size`). */
  size: number;
  /** ISO timestamp when the object was last modified, parsed into a Date for parity with R2. */
  uploaded: Date;
}

/**
 * Upload a single file. Returns the key on success — the caller persists
 * it on the file_assets table. `body` accepts anything `fetch` accepts as
 * a body: ArrayBuffer, ArrayBufferView, ReadableStream, Blob, string,
 * Uint8Array, etc.
 *
 * Uses `x-upsert: true` so re-uploading the same key replaces the
 * object idempotently (matches R2's `put` semantics).
 */
export async function putFile(
  env: SupabaseStorageEnv,
  bucketOrKey: string,
  keyOrBody:
    | string
    | ArrayBuffer
    | ArrayBufferView
    | ReadableStream
    | Blob
    | Uint8Array
    | null,
  bodyOrContentType?:
    | ArrayBuffer
    | ArrayBufferView
    | ReadableStream
    | Blob
    | Uint8Array
    | string
    | null,
  contentType?: string,
): Promise<string> {
  // Two call shapes:
  //   putFile(env, key, body, contentType)            — legacy (DEFAULT_BUCKET)
  //   putFile(env, bucket, key, body, contentType)    — explicit bucket
  const explicitBucketForm = typeof keyOrBody === "string";
  const bucket = explicitBucketForm ? bucketOrKey : DEFAULT_BUCKET;
  const key = explicitBucketForm ? (keyOrBody as string) : bucketOrKey;
  const body = (
    explicitBucketForm ? bodyOrContentType : keyOrBody
  ) as BodyInit | null;
  const ct = (explicitBucketForm ? contentType : (bodyOrContentType as string)) ??
    "application/octet-stream";

  const { projectRef, serviceKey } = requireConfig(env);
  const url = `${storageBaseUrl(projectRef)}/object/${encodeURIComponent(bucket)}/${encodeObjectPath(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": ct,
      // Re-upload of the same key replaces the object instead of 409'ing,
      // matching R2's `put` semantics.
      "x-upsert": "true",
    },
    body: body as BodyInit,
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `[supabase-storage] putFile ${bucket}/${key} failed: ${res.status} ${text}`,
    );
  }
  return key;
}

/**
 * Object-body wrapper exposing the same `.body` ReadableStream surface
 * that the old R2 helper returned (R2ObjectBody). Routes that streamed
 * the body straight to a Response don't need to change.
 */
export interface StorageObjectBody {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
}

/**
 * Fetch an object body. Returns null when the key does not exist
 * (matches R2's `get` semantics — callers map a null to 404).
 */
export async function getFile(
  env: SupabaseStorageEnv,
  bucketOrKey: string,
  keyMaybe?: string,
): Promise<StorageObjectBody | null> {
  const explicitBucketForm = typeof keyMaybe === "string";
  const bucket = explicitBucketForm ? bucketOrKey : DEFAULT_BUCKET;
  const key = explicitBucketForm ? keyMaybe! : bucketOrKey;

  const { projectRef, serviceKey } = requireConfig(env);
  // The /authenticated path is the Storage v1 endpoint that returns the
  // object body when the caller bears the service_role key. Public
  // buckets also expose /public/, but we keep buckets private — every
  // download flows through the worker's auth gate (or a signed URL).
  const url = `${storageBaseUrl(projectRef)}/object/authenticated/${encodeURIComponent(bucket)}/${encodeObjectPath(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `[supabase-storage] getFile ${bucket}/${key} failed: ${res.status} ${text}`,
    );
  }
  if (!res.body) return null;
  const contentLength = Number(res.headers.get("Content-Length") ?? "0");
  return {
    body: res.body,
    contentType:
      res.headers.get("Content-Type") ?? "application/octet-stream",
    size: Number.isFinite(contentLength) ? contentLength : 0,
  };
}

/**
 * Generate a short-lived presigned download URL via the Supabase Storage
 * sign endpoint. `ttlSeconds` defaults to 5 minutes — the browser only
 * needs enough time to follow a 302 redirect. Returns null on any
 * failure (caller should fall through to a /stream proxy that streams
 * the body via the Worker).
 */
export async function signedDownloadUrl(
  env: SupabaseStorageEnv,
  bucketOrKey: string,
  keyOrTtl?: string | number,
  ttlSecondsMaybe?: number,
): Promise<string | null> {
  // Two call shapes:
  //   signedDownloadUrl(env, key, ttlSeconds)               — legacy
  //   signedDownloadUrl(env, bucket, key, ttlSeconds)       — explicit
  const explicitBucketForm = typeof keyOrTtl === "string";
  const bucket = explicitBucketForm ? bucketOrKey : DEFAULT_BUCKET;
  const key = explicitBucketForm ? (keyOrTtl as string) : bucketOrKey;
  const ttlSeconds = (explicitBucketForm
    ? ttlSecondsMaybe
    : (keyOrTtl as number | undefined)) ?? 300;

  let projectRef: string;
  let serviceKey: string;
  try {
    ({ projectRef, serviceKey } = requireConfig(env));
  } catch {
    return null;
  }
  const url = `${storageBaseUrl(projectRef)}/object/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!res.ok) {
      console.warn(
        `[supabase-storage] signedDownloadUrl ${bucket}/${key} failed: ${res.status}`,
      );
      return null;
    }
    const j = (await res.json()) as { signedURL?: string; signedUrl?: string };
    // The API returns `signedURL` historically and `signedUrl` on newer
    // versions; accept both. The value is a path beginning with /object/sign/...
    // — prepend the storage base URL.
    const path = j.signedURL ?? j.signedUrl;
    if (!path) return null;
    return path.startsWith("http")
      ? path
      : `${storageBaseUrl(projectRef)}${path.startsWith("/") ? path : `/${path}`}`;
  } catch (err) {
    console.warn(
      "[supabase-storage] signedDownloadUrl threw; falling back to stream proxy:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Delete an object. Idempotent: deleting a non-existent key is a no-op
 * and resolves to `void` rather than throwing — matches R2's `delete`
 * semantics.
 */
export async function deleteFile(
  env: SupabaseStorageEnv,
  bucketOrKey: string,
  keyMaybe?: string,
): Promise<void> {
  const explicitBucketForm = typeof keyMaybe === "string";
  const bucket = explicitBucketForm ? bucketOrKey : DEFAULT_BUCKET;
  const key = explicitBucketForm ? keyMaybe! : bucketOrKey;

  const { projectRef, serviceKey } = requireConfig(env);
  const url = `${storageBaseUrl(projectRef)}/object/${encodeURIComponent(bucket)}/${encodeObjectPath(key)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  // 200 OK on delete, 404 = already gone (idempotent).
  if (!res.ok && res.status !== 404) {
    const text = await safeReadText(res);
    throw new Error(
      `[supabase-storage] deleteFile ${bucket}/${key} failed: ${res.status} ${text}`,
    );
  }
}

/**
 * List object keys under a given prefix, optionally limited by count.
 * Used by the daily-backup retention pruner. Returns objects with `.key`,
 * `.size`, `.uploaded` so callers from the old R2 path don't need to
 * change shape.
 *
 * Supabase Storage's /list endpoint takes a folder prefix and returns
 * direct children only. We strip a trailing slash from the caller's
 * prefix and pass the rest through verbatim.
 */
export async function listFiles(
  env: SupabaseStorageEnv,
  bucketOrPrefix: string,
  prefixOrLimit?: string | number,
  limitMaybe?: number,
): Promise<StorageObject[]> {
  // Two call shapes:
  //   listFiles(env, prefix, limit)                — legacy (DEFAULT_BUCKET)
  //   listFiles(env, bucket, prefix, limit)        — explicit
  const explicitBucketForm = typeof prefixOrLimit === "string";
  const bucket = explicitBucketForm ? bucketOrPrefix : DEFAULT_BUCKET;
  const prefix = explicitBucketForm
    ? (prefixOrLimit as string)
    : bucketOrPrefix;
  const limit = (explicitBucketForm
    ? limitMaybe
    : (prefixOrLimit as number | undefined)) ?? 1000;

  const { projectRef, serviceKey } = requireConfig(env);
  // Supabase wants the folder WITHOUT a trailing slash (it appends one
  // internally); the on-folder file names returned by the API are
  // relative to that prefix, so we re-prefix them in the result so
  // callers continue to see fully-qualified keys (parity with R2 list).
  const folder = prefix.replace(/\/+$/, "");
  const url = `${storageBaseUrl(projectRef)}/object/list/${encodeURIComponent(bucket)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prefix: folder,
      limit,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    }),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      `[supabase-storage] listFiles ${bucket}/${prefix} failed: ${res.status} ${text}`,
    );
  }
  type RawListItem = {
    name: string;
    updated_at?: string;
    created_at?: string;
    metadata?: { size?: number } | null;
  };
  const raw = (await res.json()) as RawListItem[];
  const reprefix = folder.length > 0 ? `${folder}/` : "";
  return raw.map((item) => {
    const ts = item.updated_at ?? item.created_at ?? new Date().toISOString();
    return {
      key: `${reprefix}${item.name}`,
      size: item.metadata?.size ?? 0,
      uploaded: new Date(ts),
    };
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
