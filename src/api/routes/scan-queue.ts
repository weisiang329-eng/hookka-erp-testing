// ---------------------------------------------------------------------------
// Background scan queue — async OCR processing for scan-po + scan-supplier.
//
// Why this exists
// ---------------
// The legacy /api/scan-po/extract + /api/scan-supplier/extract endpoints
// hold the HTTP connection while Claude vision runs (90-180s per file).
// Closing the tab kills the request. Batch uploads of 50-100 files were
// failing silently when the modal disconnected.
//
// Flow
// ----
//   1. POST /api/scan-queue/upload — multipart with `kind=po|supplier`,
//      `files[]`, optional `supplierId`. Returns IMMEDIATELY with
//      `{ batchId, items: [{ id, fileName, status, cached }] }`.
//   2. waitUntil() kicks off processBatch() server-side. The Workers
//      runtime keeps the worker alive past the response until the promise
//      settles, so processing continues even after the client disconnects.
//   3. The browser navigates to /scan-queue/<batchId> which polls
//      GET /api/scan-queue/batch/:batchId every 5s.
//   4. Per-file SHA-256 file_hash cache: re-uploading the same bytes
//      returns the prior 'done' row's raw_json INSTANTLY with no Claude
//      call. Inserted as a fresh row with status='cached' for audit.
//   5. Cron sweep at /api/internal/scan-queue-sweep re-queues any
//      'processing' row older than 5 minutes (worker died mid-batch).
//
// File storage strategy
// ---------------------
// Production: TEMPORARILY stash raw file bytes as base64 in
// `scan_queue.file_bytes_b64`. 32MB max per file × Workers JSONB tolerates
// it fine for a single-row read/write. The column is NULLed the moment the
// row's status flips to 'done' or 'failed' — so the table doesn't grow
// unbounded. Once the owner wires an R2 bucket binding (or Supabase
// Storage `scans` bucket), swap the b64 column for an object key.
//
// Auth: same `requirePermission(c, "purchase-orders", "create")` gate as
// the existing /api/scan-po + /api/scan-supplier routes.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { runExtract } from "../lib/scan-engine";

const app = new Hono<Env>();

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const STUCK_MS = 5 * 60 * 1000;

// ---------- IDs --------------------------------------------------------
function genBatchId(): string {
  return `sqb-${crypto.randomUUID().slice(0, 12)}`;
}
function genItemId(): string {
  return `sqi-${crypto.randomUUID().slice(0, 12)}`;
}

// ---------- helpers ----------------------------------------------------
// ArrayBuffer → base64. Chunked to keep stack bounded on a 32MB file —
// same pattern as scan-po.ts / scan-supplier.ts. Workers don't have Node's
// Buffer.
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Runtime self-apply — deploy doesn't auto-run migration files (per
// CLAUDE.md). Idempotent; safe to call at the top of every handler.
let scanQueueTableEnsured = false;
async function ensureScanQueueTable(
  db: Env["Variables"]["DB"],
): Promise<void> {
  if (scanQueueTableEnsured) return;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS scan_queue (
           id              TEXT PRIMARY KEY,
           batch_id        TEXT NOT NULL,
           kind            TEXT NOT NULL,
           file_hash       TEXT NOT NULL,
           file_name       TEXT NOT NULL,
           mime_type       TEXT NOT NULL,
           file_size       INTEGER NOT NULL DEFAULT 0,
           file_bytes_b64  TEXT,
           supplier_id     TEXT,
           po_context      TEXT,
           status          TEXT NOT NULL,
           raw_json        JSONB,
           error           TEXT,
           cache_source_id TEXT,
           created_by      TEXT,
           created_at      TEXT NOT NULL,
           started_at      TEXT,
           completed_at    TEXT,
           org_id          TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS scan_queue_batch_idx ON scan_queue (batch_id)",
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS scan_queue_status_idx ON scan_queue (status, created_at)",
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS scan_queue_hash_idx ON scan_queue (file_hash)",
      )
      .run();
    scanQueueTableEnsured = true;
  } catch (e) {
    // No DDL perms in some environments — let the route's first INSERT fail
    // loudly with a clear error rather than silently breaking everything.
    console.warn("[scan-queue] ensureScanQueueTable:", (e as Error).message);
  }
}

type ScanKind = "po" | "supplier";

type ScanQueueRow = {
  id: string;
  batchId: string;
  kind: ScanKind;
  fileHash: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  supplierId: string | null;
  poContext: string | null;
  status: "queued" | "processing" | "done" | "failed" | "cached";
  rawJson: unknown | null;
  error: string | null;
  cacheSourceId: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  orgId: string | null;
};

// Hydrate a DB row (camelCase via the adapter's projection) into our typed
// ScanQueueRow shape. Tolerates raw_json arriving as a JSON string vs already
// parsed JSONB object — postgres.js sometimes hands JSONB back as a string
// depending on connection settings.
function hydrateRow(r: Record<string, unknown>): ScanQueueRow {
  let rawJson: unknown | null = null;
  const raw = r.rawJson ?? r.raw_json;
  if (raw != null) {
    if (typeof raw === "string") {
      try {
        rawJson = JSON.parse(raw);
      } catch {
        rawJson = raw;
      }
    } else {
      rawJson = raw;
    }
  }
  return {
    id: String(r.id ?? ""),
    batchId: String(r.batchId ?? r.batch_id ?? ""),
    kind: String(r.kind ?? "po") as ScanKind,
    fileHash: String(r.fileHash ?? r.file_hash ?? ""),
    fileName: String(r.fileName ?? r.file_name ?? ""),
    mimeType: String(r.mimeType ?? r.mime_type ?? ""),
    fileSize: Number(r.fileSize ?? r.file_size ?? 0),
    supplierId: (r.supplierId ?? r.supplier_id ?? null) as string | null,
    poContext: (r.poContext ?? r.po_context ?? null) as string | null,
    status: String(r.status ?? "queued") as ScanQueueRow["status"],
    rawJson,
    error: (r.error ?? null) as string | null,
    cacheSourceId: (r.cacheSourceId ?? r.cache_source_id ?? null) as
      | string
      | null,
    createdBy: (r.createdBy ?? r.created_by ?? null) as string | null,
    createdAt: String(r.createdAt ?? r.created_at ?? ""),
    startedAt: (r.startedAt ?? r.started_at ?? null) as string | null,
    completedAt: (r.completedAt ?? r.completed_at ?? null) as string | null,
    orgId: (r.orgId ?? r.org_id ?? null) as string | null,
  };
}

// ---------------------------------------------------------------------------
// processBatch — the actual OCR worker. Runs under c.executionCtx.waitUntil
// so it survives after the upload response is flushed.
//
// Sequential per-batch (one Claude call at a time) to stay under Anthropic's
// 30K tokens/min tier-1 budget. The batch worker iterates queued rows in
// insertion order; the cron sweeper handles re-kicking stuck batches.
// ---------------------------------------------------------------------------
async function processBatch(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  batchId: string,
): Promise<void> {
  while (true) {
    let next: ScanQueueRow | null = null;
    try {
      const res = await db
        .prepare(
          `SELECT * FROM scan_queue
            WHERE batch_id = ? AND status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1`,
        )
        .bind(batchId)
        .first<Record<string, unknown>>();
      next = res ? hydrateRow(res) : null;
    } catch (e) {
      console.error("[scan-queue] poll failed:", (e as Error).message);
      return;
    }
    if (!next) return; // batch drained

    const nowIso = new Date().toISOString();
    // Claim the row — UPDATE … WHERE status = 'queued' so a parallel
    // sweeper can't double-claim. If the UPDATE matches zero rows the
    // worker just loops to grab a different one.
    let claimed = false;
    try {
      const upd = await db
        .prepare(
          `UPDATE scan_queue
              SET status = 'processing', started_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .bind(nowIso, next.id)
        .run();
      claimed = (upd.meta?.changes ?? 0) > 0;
    } catch (e) {
      console.error("[scan-queue] claim failed:", (e as Error).message);
    }
    if (!claimed) continue;

    let result: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      if (!next.fileSize) {
        result = { ok: false, error: "Missing file bytes" };
      } else {
        // Re-fetch the bytes (we deliberately don't carry a 32MB string in
        // memory between the queue poll and the API call — read it now).
        const row = await db
          .prepare("SELECT file_bytes_b64 FROM scan_queue WHERE id = ?")
          .bind(next.id)
          .first<{ fileBytesB64: string | null }>();
        const b64 = row?.fileBytesB64 ?? null;
        if (!b64) {
          result = {
            ok: false,
            error:
              "File bytes evicted before processing (re-upload to re-queue)",
          };
        } else {
          // Direct in-process call into the shared scan engine. No self-fetch,
          // no shared-secret needed (the previous SCAN_WORKER_TOKEN auth bypass
          // is gone — owner ruling 2026-06-29 evening). Per-supplier rules +
          // few-shot examples + sample recording all live in scan-engine.ts and
          // run the same way whether invoked from the sync /extract endpoint or
          // here in the background queue.
          const bytes = base64ToArrayBuffer(b64);
          result = await runExtract(db, env, {
            kind: next.kind,
            bytes,
            mimeType: next.mimeType,
            fileName: next.fileName,
            orgId: next.orgId ?? "",
            createdBy: next.createdBy,
            supplierId: next.supplierId,
            poContext: next.poContext ?? undefined,
            recordSample: true,
          });
        }
      }
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }

    const completedAt = new Date().toISOString();
    try {
      if (result.ok) {
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'done',
                    raw_json = ?,
                    file_bytes_b64 = NULL,
                    completed_at = ?,
                    error = NULL
              WHERE id = ?`,
          )
          .bind(JSON.stringify(result.data), completedAt, next.id)
          .run();
      } else {
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'failed',
                    error = ?,
                    completed_at = ?
              WHERE id = ?`,
          )
          .bind(result.error.slice(0, 2000), completedAt, next.id)
          .run();
      }
    } catch (e) {
      console.error("[scan-queue] result write failed:", (e as Error).message);
      return;
    }
  }
}

// (Removed runPoExtract / runSupplierExtract / runRemoteExtract — the
// background queue worker now calls runExtract from scan-engine.ts
// directly. No self-fetch, no SCAN_WORKER_TOKEN, no APP_URL.)

// ---------------------------------------------------------------------------
// POST /api/scan-queue/upload
// multipart: kind=po|supplier, files[], supplierId?, poContext?
// Returns: { batchId, items: [{ id, fileName, status, cached, fileHash }] }
// ---------------------------------------------------------------------------
app.post("/upload", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json(
      {
        success: false,
        error: `Invalid multipart body: ${(e as Error).message}`,
      },
      400,
    );
  }

  const kindRaw = String(formData.get("kind") ?? "").trim();
  if (kindRaw !== "po" && kindRaw !== "supplier") {
    return c.json(
      { success: false, error: "Missing/invalid `kind` (must be 'po' or 'supplier')." },
      400,
    );
  }
  const kind: ScanKind = kindRaw;

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return c.json({ success: false, error: "No files in `files[]`." }, 400);
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return c.json(
        {
          success: false,
          error: `${f.name} is over the 32MB limit (${(f.size / 1024 / 1024).toFixed(1)}MB).`,
        },
        400,
      );
    }
  }

  const supplierId =
    (formData.get("supplierId") as string | null)?.trim() || null;
  const poContext = (formData.get("poContext") as string | null)?.trim() || null;
  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;
  const orgId = getOrgId(c);
  const batchId = genBatchId();
  const nowIso = new Date().toISOString();

  type ItemRow = {
    id: string;
    fileName: string;
    status: ScanQueueRow["status"];
    cached: boolean;
    fileHash: string;
  };
  const items: ItemRow[] = [];

  for (const file of files) {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);

    // Cache lookup — same bytes already scanned (any batch, any time, this
    // org) → reuse its raw_json. Insert a fresh row marked 'cached' for audit.
    let cacheSource: { id: string; rawJson: string | null } | null = null;
    try {
      cacheSource = await c.var.DB.prepare(
        `SELECT id, raw_json AS "rawJson"
           FROM scan_queue
          WHERE file_hash = ?
            AND kind = ?
            AND status = 'done'
            AND (org_id = ? OR org_id IS NULL)
          ORDER BY completed_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
      )
        .bind(hash, kind, orgId)
        .first<{ id: string; rawJson: string | null }>();
    } catch (e) {
      console.warn("[scan-queue] cache lookup:", (e as Error).message);
    }

    const id = genItemId();
    if (cacheSource && cacheSource.rawJson != null) {
      // Cache HIT — store the prior raw_json on this row directly so the
      // queue page renders it without an extra hop.
      try {
        await c.var.DB.prepare(
          `INSERT INTO scan_queue
             (id, batch_id, kind, file_hash, file_name, mime_type, file_size,
              file_bytes_b64, supplier_id, po_context, status, raw_json,
              cache_source_id, created_by, created_at, completed_at, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'cached', ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            batchId,
            kind,
            hash,
            file.name,
            file.type || "application/octet-stream",
            file.size,
            supplierId,
            poContext,
            // raw_json comes back as a string from postgres.js when JSONB
            // — pass through verbatim so we don't double-stringify.
            cacheSource.rawJson,
            cacheSource.id,
            createdBy,
            nowIso,
            nowIso,
            orgId,
          )
          .run();
      } catch (e) {
        return c.json(
          { success: false, error: `Insert (cache hit) failed: ${(e as Error).message}` },
          500,
        );
      }
      items.push({ id, fileName: file.name, status: "cached", cached: true, fileHash: hash });
    } else {
      // Cache MISS — stash the bytes b64 and enqueue.
      const b64 = toBase64(buf);
      try {
        await c.var.DB.prepare(
          `INSERT INTO scan_queue
             (id, batch_id, kind, file_hash, file_name, mime_type, file_size,
              file_bytes_b64, supplier_id, po_context, status, created_by,
              created_at, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
          .bind(
            id,
            batchId,
            kind,
            hash,
            file.name,
            file.type || "application/octet-stream",
            file.size,
            b64,
            supplierId,
            poContext,
            createdBy,
            nowIso,
            orgId,
          )
          .run();
      } catch (e) {
        return c.json(
          { success: false, error: `Insert failed: ${(e as Error).message}` },
          500,
        );
      }
      items.push({ id, fileName: file.name, status: "queued", cached: false, fileHash: hash });
    }
  }

  // Kick off the worker AFTER the response is flushed. waitUntil keeps the
  // worker alive past the response so the user can close the tab and
  // processing continues server-side.
  if (items.some((it) => it.status === "queued")) {
    c.executionCtx?.waitUntil(processBatch(c.var.DB, c.env, batchId));
  }

  return c.json({ success: true, data: { batchId, items } });
});

// ---------------------------------------------------------------------------
// GET /api/scan-queue/batch/:batchId
// ---------------------------------------------------------------------------
app.get("/batch/:batchId", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const batchId = c.req.param("batchId");
  const orgId = getOrgId(c);

  let rows;
  try {
    rows = await c.var.DB.prepare(
      `SELECT * FROM scan_queue
        WHERE batch_id = ? AND (org_id = ? OR org_id IS NULL)
        ORDER BY created_at ASC`,
    )
      .bind(batchId, orgId)
      .all<Record<string, unknown>>();
  } catch (e) {
    return c.json(
      { success: false, error: `Query failed: ${(e as Error).message}` },
      500,
    );
  }
  const items = (rows.results ?? []).map((r) => {
    const row = hydrateRow(r);
    // Don't leak the 32MB base64 blob in the polling payload.
    return {
      id: row.id,
      batchId: row.batchId,
      kind: row.kind,
      fileName: row.fileName,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      supplierId: row.supplierId,
      status: row.status,
      rawJson: row.rawJson,
      error: row.error,
      cached: row.status === "cached",
      cacheSourceId: row.cacheSourceId,
      fileHash: row.fileHash,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  });

  const summary = {
    total: items.length,
    done: items.filter((i) => i.status === "done" || i.status === "cached").length,
    failed: items.filter((i) => i.status === "failed").length,
    processing: items.filter((i) => i.status === "processing").length,
    queued: items.filter((i) => i.status === "queued").length,
    cached: items.filter((i) => i.status === "cached").length,
  };

  return c.json({ success: true, data: { batchId, items, summary } });
});

// ---------------------------------------------------------------------------
// GET /api/scan-queue/:id — single row detail (includes raw_json + error)
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const id = c.req.param("id");
  const orgId = getOrgId(c);

  let row;
  try {
    row = await c.var.DB.prepare(
      `SELECT * FROM scan_queue WHERE id = ? AND (org_id = ? OR org_id IS NULL)`,
    )
      .bind(id, orgId)
      .first<Record<string, unknown>>();
  } catch (e) {
    return c.json(
      { success: false, error: `Query failed: ${(e as Error).message}` },
      500,
    );
  }
  if (!row) {
    return c.json({ success: false, error: "Scan row not found." }, 404);
  }
  const hydrated = hydrateRow(row);
  return c.json({
    success: true,
    data: {
      id: hydrated.id,
      batchId: hydrated.batchId,
      kind: hydrated.kind,
      fileName: hydrated.fileName,
      mimeType: hydrated.mimeType,
      fileSize: hydrated.fileSize,
      supplierId: hydrated.supplierId,
      status: hydrated.status,
      rawJson: hydrated.rawJson,
      error: hydrated.error,
      cached: hydrated.status === "cached",
      cacheSourceId: hydrated.cacheSourceId,
      fileHash: hydrated.fileHash,
      createdAt: hydrated.createdAt,
      startedAt: hydrated.startedAt,
      completedAt: hydrated.completedAt,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/scan-queue/:id/retry — flip a 'failed' row back to 'queued'
// ---------------------------------------------------------------------------
app.post("/:id/retry", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const id = c.req.param("id");
  const orgId = getOrgId(c);

  let row;
  try {
    row = await c.var.DB.prepare(
      "SELECT batch_id AS \"batchId\", file_bytes_b64 AS \"fileBytesB64\", status FROM scan_queue WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
    )
      .bind(id, orgId)
      .first<{ batchId: string; fileBytesB64: string | null; status: string }>();
  } catch (e) {
    return c.json(
      { success: false, error: `Query failed: ${(e as Error).message}` },
      500,
    );
  }
  if (!row) {
    return c.json({ success: false, error: "Scan row not found." }, 404);
  }
  if (row.status !== "failed") {
    return c.json(
      { success: false, error: `Cannot retry a row with status='${row.status}'.` },
      400,
    );
  }
  if (!row.fileBytesB64) {
    return c.json(
      {
        success: false,
        error:
          "File bytes evicted from queue row — re-upload to re-scan.",
      },
      400,
    );
  }

  try {
    await c.var.DB.prepare(
      `UPDATE scan_queue
          SET status = 'queued', started_at = NULL, completed_at = NULL,
              error = NULL
        WHERE id = ?`,
    )
      .bind(id)
      .run();
  } catch (e) {
    return c.json(
      { success: false, error: `Retry update failed: ${(e as Error).message}` },
      500,
    );
  }
  c.executionCtx?.waitUntil(processBatch(c.var.DB, c.env, row.batchId));
  return c.json({ success: true, data: { id, status: "queued" } });
});

// ---------------------------------------------------------------------------
// Sweeper — internal cron hook. Re-queues any 'processing' row older than
// STUCK_MS (worker died mid-batch / Workers killed the isolate). Re-kicks
// processBatch for each affected batchId. Same CRON_SECRET pattern as the
// rest of /api/internal/*.
//
// NOTE: registered separately in worker.ts at /api/internal/scan-queue-sweep
// (BEFORE the auth middleware) — we EXPORT the handler so worker.ts can
// mount it as a public path. We can't mount /sweep inside this auth-gated
// sub-app and have it work as a CRON_SECRET-gated public endpoint.
// ---------------------------------------------------------------------------
export async function sweepStuckScans(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  ctx: ExecutionContext | undefined,
): Promise<{ requeued: number; batches: string[] }> {
  await ensureScanQueueTable(db);
  const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
  let stuck;
  try {
    stuck = await db
      .prepare(
        `SELECT id, batch_id AS "batchId"
           FROM scan_queue
          WHERE status = 'processing'
            AND (started_at IS NULL OR started_at < ?)`,
      )
      .bind(cutoff)
      .all<{ id: string; batchId: string }>();
  } catch (e) {
    console.error("[scan-queue sweep] select failed:", (e as Error).message);
    return { requeued: 0, batches: [] };
  }
  const rows = stuck.results ?? [];
  if (rows.length === 0) return { requeued: 0, batches: [] };
  const ids = rows.map((r) => r.id);
  // Build a parameterized IN-list — Postgres rejects "IN ()" syntax so
  // the empty-array case is filtered above.
  const placeholders = ids.map(() => "?").join(", ");
  try {
    await db
      .prepare(
        `UPDATE scan_queue
            SET status = 'queued', started_at = NULL
          WHERE id IN (${placeholders})`,
      )
      .bind(...ids)
      .run();
  } catch (e) {
    console.error("[scan-queue sweep] update failed:", (e as Error).message);
    return { requeued: 0, batches: [] };
  }
  const batchIds = Array.from(new Set(rows.map((r) => r.batchId)));
  for (const bId of batchIds) {
    ctx?.waitUntil(processBatch(db, env, bId));
  }
  return { requeued: rows.length, batches: batchIds };
}

export default app;
