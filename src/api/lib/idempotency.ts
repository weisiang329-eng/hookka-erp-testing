// ---------------------------------------------------------------------------
// Strong idempotency for retryable business writes.
//
// Workers KV cannot provide an atomic "claim if absent" operation and its
// reads are eventually consistent. It is therefore suitable for caching a
// response, but not for preventing two concurrent money writes. The claim and
// replay record now live in Postgres behind a composite primary key:
//   (org_id, resource, idem_key)
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "./tenant";

const COMPLETE_TTL_HOURS = 24;
const PENDING_TTL_MINUTES = 5;
const MAX_KEY_LENGTH = 200;

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  org_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  response_status INTEGER,
  response_body TEXT,
  response_content_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, resource, idem_key)
)`;

const CREATE_EXPIRY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_api_idempotency_expiry
  ON api_idempotency_keys (expires_at)`;

type IdempotencyRow = {
  request_hash?: string;
  requestHash?: string;
  owner_token?: string;
  ownerToken?: string;
  state?: "pending" | "complete";
  response_status?: number | null;
  responseStatus?: number | null;
  response_body?: string | null;
  responseBody?: string | null;
  response_content_type?: string | null;
  responseContentType?: string | null;
};

export type IdempotencyClaim =
  | { kind: "claimed"; ownerToken: string }
  | { kind: "pending" }
  | { kind: "conflict" }
  | {
      kind: "replay";
      status: number;
      body: string;
      contentType: string;
    };

type ClaimInput = {
  orgId: string;
  resource: string;
  key: string;
  requestHash: string;
};

const ensureByDb = new WeakMap<object, Promise<void>>();
const cleanupByDb = new WeakMap<object, number>();

async function ensureIdempotencyTable(db: D1Database): Promise<void> {
  const dbKey = db as unknown as object;
  let pending = ensureByDb.get(dbKey);
  if (!pending) {
    pending = (async () => {
      await db.prepare(CREATE_TABLE_SQL).run();
      await db.prepare(CREATE_EXPIRY_INDEX_SQL).run();
    })();
    ensureByDb.set(dbKey, pending);
    pending.catch(() => ensureByDb.delete(dbKey));
  }
  await pending;
}

async function cleanupExpiredClaims(db: D1Database): Promise<void> {
  const dbKey = db as unknown as object;
  const now = Date.now();
  if (now - (cleanupByDb.get(dbKey) ?? 0) < 60_000) return;
  cleanupByDb.set(dbKey, now);
  try {
    await db
      .prepare("DELETE FROM api_idempotency_keys WHERE expires_at <= NOW()")
      .run();
  } catch {
    cleanupByDb.delete(dbKey);
    // Cleanup is maintenance, not part of the exact-key atomic claim.
  }
}

export function readIdempotencyKey(c: Context<Env>): string | null {
  const raw = c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH) return null;
  return trimmed;
}

export async function fingerprintRequest(request: Request): Promise<string> {
  const url = new URL(request.url);
  const body = request.body === null ? "" : await request.clone().text();
  const canonical = `${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${body}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Atomically claim one tenant/resource/key tuple through the DB primary key. */
export async function claimIdempotencyKey(
  db: D1Database,
  input: ClaimInput,
  attempt = 0,
): Promise<IdempotencyClaim> {
  await ensureIdempotencyTable(db);
  await cleanupExpiredClaims(db);
  const { orgId, resource, key, requestHash } = input;

  // Expired pending/complete records may be reclaimed. The exact-key delete
  // keeps this hot-path indexable; the expiry index supports later bulk trim.
  await db
    .prepare(
      `DELETE FROM api_idempotency_keys
        WHERE org_id = ? AND resource = ? AND idem_key = ?
          AND expires_at <= NOW()`,
    )
    .bind(orgId, resource, key)
    .run();

  const ownerToken = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `INSERT INTO api_idempotency_keys
        (org_id, resource, idem_key, request_hash, owner_token, state, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NOW() + INTERVAL '${PENDING_TTL_MINUTES} minutes')
       ON CONFLICT (org_id, resource, idem_key) DO NOTHING
       RETURNING owner_token`,
    )
    .bind(orgId, resource, key, requestHash, ownerToken)
    .first<IdempotencyRow>();

  if ((claimed?.owner_token ?? claimed?.ownerToken) === ownerToken) {
    return { kind: "claimed", ownerToken };
  }

  const existing = await db
    .prepare(
      `SELECT request_hash, state, response_status, response_body,
              response_content_type
         FROM api_idempotency_keys
        WHERE org_id = ? AND resource = ? AND idem_key = ?
        LIMIT 1`,
    )
    .bind(orgId, resource, key)
    .first<IdempotencyRow>();

  // A concurrent expiry cleanup can leave a tiny no-row window. Retry the
  // atomic INSERT once; never run the business handler without owning a row.
  if (!existing && attempt === 0) return claimIdempotencyKey(db, input, 1);
  if (!existing) throw new Error("Idempotency claim disappeared during acquisition");

  if ((existing.request_hash ?? existing.requestHash) !== requestHash) {
    return { kind: "conflict" };
  }
  if (existing.state === "complete") {
    return {
      kind: "replay",
      status: Number(existing.response_status ?? existing.responseStatus ?? 200),
      body: existing.response_body ?? existing.responseBody ?? "null",
      contentType:
        existing.response_content_type ??
        existing.responseContentType ??
        "application/json",
    };
  }
  return { kind: "pending" };
}

export async function completeIdempotencyKey(
  db: D1Database,
  input: ClaimInput & {
    ownerToken: string;
    status: number;
    body: string;
    contentType: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE api_idempotency_keys
          SET state = 'complete', response_status = ?, response_body = ?,
              response_content_type = ?,
              expires_at = NOW() + INTERVAL '${COMPLETE_TTL_HOURS} hours'
        WHERE org_id = ? AND resource = ? AND idem_key = ?
          AND owner_token = ? AND state = 'pending'`,
    )
    .bind(
      input.status,
      input.body,
      input.contentType,
      input.orgId,
      input.resource,
      input.key,
      input.ownerToken,
    )
    .run();
}

async function releaseIdempotencyKey(
  db: D1Database,
  input: ClaimInput & { ownerToken: string },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM api_idempotency_keys
        WHERE org_id = ? AND resource = ? AND idem_key = ?
          AND owner_token = ? AND state = 'pending'`,
    )
    .bind(input.orgId, input.resource, input.key, input.ownerToken)
    .run();
}

function pendingResponse(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "A request with this Idempotency-Key is already in flight. Retry once it completes.",
    }),
    {
      status: 409,
      headers: {
        "content-type": "application/json",
        "retry-after": "5",
      },
    },
  );
}

export async function withIdempotency(
  c: Context<Env>,
  resource: string,
  key: string | null,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!key) return handler();

  const requestHash = await fingerprintRequest(c.req.raw);
  const claimInput: ClaimInput = {
    orgId: getOrgId(c),
    resource,
    key,
    requestHash,
  };

  let claim: IdempotencyClaim;
  try {
    claim = await claimIdempotencyKey(c.var.DB, claimInput);
  } catch (error) {
    // A keyed money write without a strong claim is unsafe. Fail closed rather
    // than silently falling back to eventually-consistent KV.
    console.error("[idempotency] database claim failed", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Could not establish a safe idempotency claim. Nothing was written; retry shortly.",
      }),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } },
    );
  }

  if (claim.kind === "pending") return pendingResponse();
  if (claim.kind === "conflict") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "This Idempotency-Key was already used with a different request payload.",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (claim.kind === "replay") {
    const replayBody = claim.status === 204 || claim.status === 304 ? null : claim.body;
    return new Response(replayBody, {
      status: claim.status,
      headers: {
        "content-type": claim.contentType,
        "idempotency-replay": "true",
      },
    });
  }

  let response: Response;
  try {
    response = await handler();
  } catch (error) {
    try {
      await releaseIdempotencyKey(c.var.DB, {
        ...claimInput,
        ownerToken: claim.ownerToken,
      });
    } catch {
      // Keep the short-lived pending claim if cleanup fails; safety beats a
      // duplicate retry during an uncertain database state.
    }
    throw error;
  }

  if (response.status >= 500) {
    try {
      await releaseIdempotencyKey(c.var.DB, {
        ...claimInput,
        ownerToken: claim.ownerToken,
      });
    } catch {
      /* pending claim expires automatically */
    }
    return response;
  }

  const body = await response.clone().text();
  const contentType = response.headers.get("content-type") ?? "application/json";
  try {
    await completeIdempotencyKey(c.var.DB, {
      ...claimInput,
      ownerToken: claim.ownerToken,
      status: response.status,
      body,
      contentType,
    });
  } catch (error) {
    // Do not release the claim after the business write succeeded. A retry is
    // safer receiving 409 until expiry than executing the mutation twice.
    console.error("[idempotency] response persistence failed", error);
  }
  return response;
}
