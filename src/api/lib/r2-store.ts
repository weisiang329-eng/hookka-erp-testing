// ---------------------------------------------------------------------------
// Phase B.4 — Cloudflare R2 file-storage helper.
//
// Why this file exists:
//   The ERP today has no enterprise file storage. Invoice PDFs, BOM
//   technical drawings, and customer SO attachments all need a durable
//   object store with per-object access control. R2 is the obvious
//   choice (zero egress fees, signed URLs, S3-compatible API).
//
// API surface (intentionally narrow — the Worker runtime exposes the R2
// binding directly so we don't reach for the S3 SDK):
//   * putFile(env, key, body, contentType)        → uploads, returns key
//   * getFile(env, key)                            → fetches the body
//   * signedDownloadUrl(env, key, ttlSeconds=300)  → presigned URL
//   * deleteFile(env, key)                         → removes the object
//
// Binding contract:
//   Every helper takes the runtime `env` (matches the worker.ts Env shape)
//   and reaches into `env.FILES` (R2Bucket). When the binding is missing
//   — which it will be until `wrangler r2 bucket create hookka-files`
//   is run and the wrangler.toml block is uncommented — every helper
//   throws `R2BucketNotConfiguredError` so the calling route can map it
//   to a 503 cleanly.
//
// Security notes:
//   * Signed URLs use Workers-native R2 presigned-URL helpers (no aws-sdk
//     and no Cloudflare API token needed at runtime). TTL defaults to
//     5 minutes — enough for the browser to redirect, short enough that
//     a leaked URL is harmless.
//   * Keys MUST be opaque random ids prefixed by resourceType /
//     resourceId so a brute-force walk of the bucket can't surface
//     attachments belonging to another tenant. The route layer
//     (routes-d1/files.ts) is responsible for stamping the prefix.
// ---------------------------------------------------------------------------

/**
 * Minimal env contract — kept local so this module doesn't depend on
 * the full Hono Env type. The route layer can pass `c.env` directly.
 */
type R2BucketEnv = {
  FILES?: R2Bucket;
};

/**
 * Thrown when a route calls into r2-store but the FILES binding is
 * undefined (admin hasn't run docs/R2-SETUP.md yet). Callers should
 * map this to a 503 Service Unavailable; do NOT log the raw bucket
 * name to clients.
 */
export class R2BucketNotConfiguredError extends Error {
  constructor() {
    super("R2 binding 'FILES' not configured — see docs/R2-SETUP.md");
    this.name = "R2BucketNotConfiguredError";
  }
}

function requireBucket(env: R2BucketEnv): R2Bucket {
  const bucket = env.FILES;
  if (!bucket) throw new R2BucketNotConfiguredError();
  return bucket;
}

/**
 * Upload a single file. Returns the key on success. The key is the only
 * stable handle — caller persists it on the file_assets table and uses
 * `signedDownloadUrl` later when issuing the download.
 *
 * `body` accepts anything R2's `put` accepts: ArrayBuffer, Blob,
 * ReadableStream, string, or null.
 */
export async function putFile(
  env: R2BucketEnv,
  key: string,
  body:
    | ArrayBuffer
    | ArrayBufferView
    | ReadableStream
    | Blob
    | string
    | null,
  contentType: string,
): Promise<string> {
  const bucket = requireBucket(env);
  await bucket.put(key, body, {
    httpMetadata: { contentType },
  });
  return key;
}

/**
 * Fetch an object body. Returns null when the key does not exist
 * (vs throwing) — callers map a null to 404. R2's `get` resolves to
 * `null` on miss, so we just pass it through.
 */
export async function getFile(
  env: R2BucketEnv,
  key: string,
): Promise<R2ObjectBody | null> {
  const bucket = requireBucket(env);
  return bucket.get(key);
}

/**
 * Generate a short-lived presigned download URL. R2's binding API
 * exposes `createPresignedUrl` on the bucket itself in modern runtimes;
 * we use it directly so we don't pull in aws-sdk or carry an API token
 * around. `ttlSeconds` defaults to 5 minutes — the browser only needs
 * enough time to follow a 302 redirect.
 *
 * If the underlying runtime does not yet expose presigned-URL helpers
 * (older compatibility dates), we fall back to a thin proxy: callers
 * should redirect to `/api/files/:id/stream` instead, which serves the
 * body through the Worker. That fallback lives in routes-d1/files.ts.
 */
export async function signedDownloadUrl(
  env: R2BucketEnv,
  key: string,
  ttlSeconds: number = 300,
): Promise<string | null> {
  const bucket = requireBucket(env);
  // R2 binding presigned URLs are still rolling out runtime-wide; use
  // duck-typing so this file compiles against the workers-types version
  // shipping today AND the newer runtimes that have native support.
  const maybeSign = (
    bucket as unknown as {
      createPresignedUrl?: (
        opts: { key: string; expiresIn: number; method: "GET" },
      ) => Promise<string>;
    }
  ).createPresignedUrl;
  if (typeof maybeSign === "function") {
    try {
      return await maybeSign.call(bucket, {
        key,
        expiresIn: ttlSeconds,
        method: "GET",
      });
    } catch (err) {
      console.warn(
        "[r2-store] createPresignedUrl failed; falling back to stream proxy:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Fall back: caller should serve via /api/files/:id/stream proxy.
  return null;
}

/**
 * Delete an object. Idempotent: deleting a non-existent key is a no-op
 * and resolves to `void` rather than throwing.
 */
export async function deleteFile(env: R2BucketEnv, key: string): Promise<void> {
  const bucket = requireBucket(env);
  await bucket.delete(key);
}

/**
 * List object keys under a given prefix, optionally limited by count.
 * Used by the daily-backup retention pruner (Phase C #7) and the
 * `/api/files?resourceType=&resourceId=` admin browser.
 *
 * Returns the raw R2Objects array — each has `.key`, `.size`, `.uploaded`.
 */
export async function listFiles(
  env: R2BucketEnv,
  prefix: string,
  limit: number = 1000,
): Promise<R2Object[]> {
  const bucket = requireBucket(env);
  const result = await bucket.list({ prefix, limit });
  return result.objects;
}
