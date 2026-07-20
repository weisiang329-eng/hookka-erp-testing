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
import {
  runExtract,
  detectSupplierDocBoundaries,
  splitPdfByChunks,
  getPdfPageCount,
} from "../lib/scan-engine";

const app = new Hono<Env>();

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const STUCK_MS = 5 * 60 * 1000;
// How many OCR attempts a single row gets before it's declared 'failed'.
// A timed-out / dead-worker row is re-queued for another go (the claim bumps
// `attempts`); only after this many misses does it surface as failed so a
// genuinely-bad page stops re-running (and re-billing the AI) forever.
const MAX_OCR_ATTEMPTS = 3;

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
           attempts        INTEGER NOT NULL DEFAULT 0,
           cache_source_id TEXT,
           created_by      TEXT,
           created_at      TEXT NOT NULL,
           started_at      TEXT,
           completed_at    TEXT,
           org_id          TEXT,
           consumed_at     TIMESTAMP
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
    // Runtime self-apply for the consumed_at column added 2026-06-29 (owner
    // ruling). The CREATE TABLE above carries it for fresh installs; this
    // ALTER ... IF NOT EXISTS handles existing deployments. Once the modal
    // creates a PI/GRN/SO from a queue row, that row's consumed_at flips
    // and /api/scan-queue/pending stops resurfacing it.
    await db
      .prepare(
        "ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP",
      )
      .run();
    // Per-doc consumed tracking added 2026-06-30. A single queue row can
    // produce N preview cards (rawJson.docs[] for supplier, rawJson.pos[]
    // for PO). The modal lets the operator X-delete one card without
    // discarding the whole row — we record which docIdxs have been
    // consumed and only stamp consumed_at once every doc is accounted for.
    await db
      .prepare(
        "ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS consumed_doc_idxs JSONB DEFAULT '[]'::jsonb",
      )
      .run();
    // Per-row OCR attempt counter (2026-06-30). A transient failure (AI call
    // timed out, worker isolate killed mid-OCR) re-queues the row for an
    // automatic retry instead of failing it on the first miss; after
    // MAX_OCR_ATTEMPTS the row is marked 'failed' so a genuinely bad page
    // surfaces to the operator instead of re-running (and re-billing) forever.
    await db
      .prepare(
        "ALTER TABLE scan_queue ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0",
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS scan_queue_pending_idx ON scan_queue (created_by, created_at) WHERE consumed_at IS NULL",
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
  status: "queued" | "processing" | "done" | "failed" | "cached" | "split";
  rawJson: unknown | null;
  error: string | null;
  attempts: number;
  cacheSourceId: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  orgId: string | null;
  consumedAt: string | null;
  consumedDocIdxs: number[];
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
  // consumed_doc_idxs comes back as JSONB — sometimes a parsed array (postgres
  // hands JSONB back as JS), sometimes a JSON string (string mode connections).
  // Tolerate both; default to [] for legacy rows that pre-date the column.
  let consumedDocIdxs: number[] = [];
  const cdi = r.consumedDocIdxs ?? r.consumed_doc_idxs;
  if (cdi != null) {
    if (typeof cdi === "string") {
      try {
        const parsed = JSON.parse(cdi);
        if (Array.isArray(parsed)) {
          consumedDocIdxs = parsed
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n) && n >= 0);
        }
      } catch {
        /* leave as [] */
      }
    } else if (Array.isArray(cdi)) {
      consumedDocIdxs = cdi
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 0);
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
    attempts: Number(r.attempts ?? 0),
    cacheSourceId: (r.cacheSourceId ?? r.cache_source_id ?? null) as
      | string
      | null,
    createdBy: (r.createdBy ?? r.created_by ?? null) as string | null,
    createdAt: String(r.createdAt ?? r.created_at ?? ""),
    startedAt: (r.startedAt ?? r.started_at ?? null) as string | null,
    completedAt: (r.completedAt ?? r.completed_at ?? null) as string | null,
    orgId: (r.orgId ?? r.org_id ?? null) as string | null,
    consumedAt: (r.consumedAt ?? r.consumed_at ?? null) as string | null,
    consumedDocIdxs,
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
// Owner ruling 2026-06-30: auto-split already chops a 130-page PDF into ~30
// children, but a SINGLE serial worker still processed them one-at-a-time
// (30 children × ~30-60s each = 15-30 min wait). Run N processOneRow loops
// in parallel — each claims a queued row, processes it, loops for the next.
// 6 concurrent fits comfortably under Cloudflare Workers memory (each row
// holds ~1-2MB bytes + a Sonnet call's in-flight state). The atomic UPDATE
// claim guards against two workers grabbing the same row.
const PROCESS_BATCH_CONCURRENCY = 6;

async function processBatch(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  batchId: string,
): Promise<void> {
  const workers = Array.from({ length: PROCESS_BATCH_CONCURRENCY }, () =>
    processOneAtATime(db, env, batchId),
  );
  await Promise.allSettled(workers);
}

async function processOneAtATime(
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
              SET status = 'processing',
                  started_at = ?,
                  attempts = COALESCE(attempts, 0) + 1
            WHERE id = ? AND status = 'queued'`,
        )
        .bind(nowIso, next.id)
        .run();
      claimed = (upd.meta?.changes ?? 0) > 0;
    } catch (e) {
      console.error("[scan-queue] claim failed:", (e as Error).message);
    }
    if (!claimed) continue;

    // Which attempt this is (1-based). The claim above bumped the stored
    // counter; `next` was read pre-bump, so add 1. Drives the retry-vs-fail
    // decision in the result writer below.
    const attemptNo = (next.attempts ?? 0) + 1;

    let result: { ok: true; data: unknown } | { ok: false; error: string };
    // When the row was auto-split into N child rows, set this so the result
    // writer below knows to mark the parent 'split' instead of 'done' and
    // NOT to write the rawJson (children own that). Stored on the parent's
    // error column as a JSON marker — keeps the modal's audit trail intact.
    let splitMarker: {
      chunks: { startPage: number; endPage: number; childId: string }[];
    } | null = null;
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
          const bytes = base64ToArrayBuffer(b64);
          // Auto-split branch (owner ruling 2026-06-30). Multi-page PDFs may
          // bundle N separate supplier docs (e.g. an 85-page file with 16
          // PIs). Ask Haiku for the page-range boundaries BEFORE the heavy
          // extractor runs — if it returns >1 chunk we slice the source into
          // child PDFs and enqueue each as a sibling row. Each child OCR
          // runs independently and appears in the modal preview the moment
          // it lands; the 5-10 min monolithic wait is gone.
          //
          // Single-page images and ≤2-page PDFs skip detection entirely (no
          // Haiku call burned). Detector errors / single-chunk results fall
          // through to the normal extractor path — graceful degradation.
          const looksLikeImage = next.mimeType.startsWith("image/");
          let didSplit = false;
          if (!looksLikeImage) {
            const pageCount = await getPdfPageCount(bytes);
            if (pageCount >= 3) {
              const det = await detectSupplierDocBoundaries(
                bytes,
                next.mimeType,
                env,
              );
              if ("chunks" in det && det.chunks.length > 1) {
                // Multi-document PDF → split + enqueue children.
                try {
                  const children = await splitPdfByChunks(bytes, det.chunks);
                  if (children.length > 1) {
                    const childRecords: {
                      startPage: number;
                      endPage: number;
                      childId: string;
                    }[] = [];
                    const nowChildIso = new Date().toISOString();
                    for (const child of children) {
                      const childId = genItemId();
                      const childBytes = child.pdfBytes.buffer.slice(
                        child.pdfBytes.byteOffset,
                        child.pdfBytes.byteOffset + child.pdfBytes.byteLength,
                      ) as ArrayBuffer;
                      const childHash = await sha256Hex(childBytes);
                      // file_hash cache lookup for the CHILD bytes — same
                      // bytes seen before? reuse rawJson + mark cached so
                      // the modal renders it instantly.
                      let cacheSource: {
                        id: string;
                        rawJson: string | null;
                      } | null = null;
                      try {
                        cacheSource = await db
                          .prepare(
                            `SELECT id, raw_json AS "rawJson"
                               FROM scan_queue
                              WHERE file_hash = ?
                                AND kind = ?
                                AND status = 'done'
                                AND (org_id = ? OR org_id IS NULL)
                              ORDER BY completed_at DESC NULLS LAST, created_at DESC
                              LIMIT 1`,
                          )
                          .bind(
                            childHash,
                            next.kind,
                            next.orgId ?? "",
                          )
                          .first<{ id: string; rawJson: string | null }>();
                      } catch (e) {
                        console.warn(
                          "[scan-queue] child cache lookup:",
                          (e as Error).message,
                        );
                      }
                      const childFileName = `${next.fileName.replace(/\.pdf$/i, "")}-pi-${child.startPage}-${child.endPage}.pdf`;
                      if (cacheSource && cacheSource.rawJson != null) {
                        // Cache HIT — insert as 'cached'; keep child bytes
                        // so the PI link-to-source-doc upload step can grab
                        // them later via /api/scan-queue/:id/bytes.
                        const childB64 = toBase64(childBytes);
                        await db
                          .prepare(
                            `INSERT INTO scan_queue
                               (id, batch_id, kind, file_hash, file_name, mime_type, file_size,
                                file_bytes_b64, supplier_id, po_context, status, raw_json,
                                cache_source_id, created_by, created_at, completed_at, org_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cached', ?, ?, ?, ?, ?, ?)`,
                          )
                          .bind(
                            childId,
                            next.batchId,
                            next.kind,
                            childHash,
                            childFileName,
                            "application/pdf",
                            childBytes.byteLength,
                            childB64,
                            next.supplierId,
                            next.poContext,
                            cacheSource.rawJson,
                            cacheSource.id,
                            next.createdBy,
                            nowChildIso,
                            nowChildIso,
                            next.orgId ?? "",
                          )
                          .run();
                      } else {
                        const childB64 = toBase64(childBytes);
                        await db
                          .prepare(
                            `INSERT INTO scan_queue
                               (id, batch_id, kind, file_hash, file_name, mime_type, file_size,
                                file_bytes_b64, supplier_id, po_context, status, created_by,
                                created_at, org_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
                          )
                          .bind(
                            childId,
                            next.batchId,
                            next.kind,
                            childHash,
                            childFileName,
                            "application/pdf",
                            childBytes.byteLength,
                            childB64,
                            next.supplierId,
                            next.poContext,
                            next.createdBy,
                            nowChildIso,
                            next.orgId ?? "",
                          )
                          .run();
                      }
                      childRecords.push({
                        startPage: child.startPage,
                        endPage: child.endPage,
                        childId,
                      });
                    }
                    splitMarker = { chunks: childRecords };
                    didSplit = true;
                    // Mark the result OK so the result writer below picks
                    // the 'split' branch (it inspects splitMarker).
                    result = { ok: true, data: null };
                  } else {
                    // The splitter returned ≤1 child (defensive — boundary
                    // detector said >1 but pdf-lib filtered them out).
                    // Fall through to the normal single-extract path.
                  }
                } catch (e) {
                  console.warn(
                    "[scan-queue] split failed, falling back:",
                    (e as Error).message,
                  );
                }
              }
              // Detector error or single chunk → fall through (process the
              // PDF as one document). Best-effort; never block extraction
              // on detection failure.
            }
          }
          if (!didSplit) {
            // Normal single-document extract.
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
          } else {
            // result already set above to { ok:true, data:null } for split path
            result = result!;
          }
        }
      }
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }

    const completedAt = new Date().toISOString();
    try {
      if (splitMarker) {
        // Parent of an auto-split — children own the bytes now. NULL the
        // parent's file_bytes_b64 (children store their own) and stash the
        // chunks marker in `error` for audit/debug. status='split' is
        // terminal for the parent; the modal hides it.
        //
        // Also stamp `consumed_at` on the parent so the /pending endpoint
        // doesn't count it as an un-consumed row when deciding whether to
        // resume the batch. The children carry the real consumed_at state.
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'split',
                    file_bytes_b64 = NULL,
                    completed_at = ?,
                    consumed_at = ?,
                    error = ?
              WHERE id = ?`,
          )
          .bind(
            completedAt,
            completedAt,
            JSON.stringify({ split: splitMarker.chunks }).slice(0, 2000),
            next.id,
          )
          .run();
      } else if (result.ok) {
        // KEEP file_bytes_b64 around — the modal's "Create as DRAFT" step
        // now uploads the row's bytes to /api/files so the PI can link
        // back to its source PDF (owner ruling 2026-06-30). Eviction
        // moves to /:id/consume — once every doc on the row is consumed,
        // bytes are NULLed.
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'done',
                    raw_json = ?,
                    completed_at = ?,
                    error = NULL
              WHERE id = ?`,
          )
          .bind(JSON.stringify(result.data), completedAt, next.id)
          .run();
      } else if (attemptNo < MAX_OCR_ATTEMPTS) {
        // Transient miss (AI call timed out, bad page, isolate hiccup) — put
        // the row back in the queue for another automatic go instead of
        // failing it on the first try. started_at=NULL so a sweeper never
        // treats the re-queued row as stuck; the next claim bumps attempts.
        // The loop re-polls 'queued' rows, so this same worker picks it up
        // again shortly.
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'queued',
                    started_at = NULL,
                    error = ?
              WHERE id = ?`,
          )
          .bind(
            `retry ${attemptNo}/${MAX_OCR_ATTEMPTS}: ${result.error.slice(0, 1900)}`,
            next.id,
          )
          .run();
      } else {
        // Out of retries — surface it to the operator (the modal shows a
        // Retry button on 'failed' rows for a manual re-run).
        await db
          .prepare(
            `UPDATE scan_queue
                SET status = 'failed',
                    error = ?,
                    completed_at = ?
              WHERE id = ?`,
          )
          .bind(
            `failed after ${MAX_OCR_ATTEMPTS} attempts: ${result.error.slice(0, 1900)}`,
            completedAt,
            next.id,
          )
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
      // queue page renders it without an extra hop. Also keep the bytes
      // (owner 2026-06-30) so the source-doc upload at PI creation time
      // can grab them via /api/scan-queue/:id/bytes — consume NULLs them.
      const b64Cached = toBase64(buf);
      try {
        await c.var.DB.prepare(
          `INSERT INTO scan_queue
             (id, batch_id, kind, file_hash, file_name, mime_type, file_size,
              file_bytes_b64, supplier_id, po_context, status, raw_json,
              cache_source_id, created_by, created_at, completed_at, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cached', ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            batchId,
            kind,
            hash,
            file.name,
            file.type || "application/octet-stream",
            file.size,
            b64Cached,
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

  // Self-heal before reading: re-queue + re-kick any row stuck 'processing'
  // past STUCK_MS so a dead-worker page recovers on this poll tick.
  await sweepStuckBatch(c.var.DB, c.env, c.executionCtx, batchId);

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
      consumedAt: row.consumedAt,
      consumedDocIdxs: row.consumedDocIdxs,
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
// GET /api/scan-queue/pending?kind=po|supplier
// Returns the user's MOST RECENT batch (within the last 7 days) that still
// has at least one un-consumed row. The modal calls this on open so an
// operator who closed the modal mid-batch lands back on the same in-flight
// preview the next time they re-open it. If `kind` is supplied, only batches
// of that kind are eligible — keeps the PI modal from resuming a PO batch.
//
// Response shape mirrors GET /batch/:batchId so the modal can use the same
// hydration path. Empty payload (`data.batchId === null`) means "no pending
// batch — show the upload step".
//
// IMPORTANT: this route MUST be registered before the `/:id` catch-all, or
// Hono will treat "pending" as a row id and shadow this endpoint.
// ---------------------------------------------------------------------------
app.get("/pending", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const orgId = getOrgId(c);
  const userId = (c.get("userId" as never) as string | undefined) ?? null;
  const kindFilter = c.req.query("kind");
  const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  if (!userId) {
    return c.json({ success: true, data: { batchId: null, items: [], summary: null } });
  }

  // Find the most recent batch (by max created_at) that the user owns and
  // still has at least one un-consumed row. Optionally constrained by kind.
  let latest: { batchId: string; createdAt: string } | null = null;
  try {
    if (kindFilter === "po" || kindFilter === "supplier") {
      latest = await c.var.DB.prepare(
        `SELECT batch_id AS "batchId", MAX(created_at) AS "createdAt"
           FROM scan_queue
          WHERE created_by = ?
            AND (org_id = ? OR org_id IS NULL)
            AND kind = ?
            AND created_at >= ?
            AND consumed_at IS NULL
          GROUP BY batch_id
          ORDER BY MAX(created_at) DESC
          LIMIT 1`,
      )
        .bind(userId, orgId, kindFilter, cutoffIso)
        .first<{ batchId: string; createdAt: string }>();
    } else {
      latest = await c.var.DB.prepare(
        `SELECT batch_id AS "batchId", MAX(created_at) AS "createdAt"
           FROM scan_queue
          WHERE created_by = ?
            AND (org_id = ? OR org_id IS NULL)
            AND created_at >= ?
            AND consumed_at IS NULL
          GROUP BY batch_id
          ORDER BY MAX(created_at) DESC
          LIMIT 1`,
      )
        .bind(userId, orgId, cutoffIso)
        .first<{ batchId: string; createdAt: string }>();
    }
  } catch (e) {
    return c.json(
      { success: false, error: `Pending query failed: ${(e as Error).message}` },
      500,
    );
  }

  if (!latest?.batchId) {
    return c.json({ success: true, data: { batchId: null, items: [], summary: null } });
  }

  // Self-heal the resumed batch: re-queue + re-kick any row stuck 'processing'
  // past STUCK_MS (see sweepStuckBatch) before returning it to the modal.
  await sweepStuckBatch(c.var.DB, c.env, c.executionCtx, latest.batchId);

  // Now pull every row for that batch (including ones already consumed, so
  // the modal can show the full audit). The modal filters out consumed
  // rows client-side when rendering cards.
  let rows;
  try {
    rows = await c.var.DB.prepare(
      `SELECT * FROM scan_queue
        WHERE batch_id = ? AND (org_id = ? OR org_id IS NULL)
        ORDER BY created_at ASC`,
    )
      .bind(latest.batchId, orgId)
      .all<Record<string, unknown>>();
  } catch (e) {
    return c.json(
      { success: false, error: `Pending fetch failed: ${(e as Error).message}` },
      500,
    );
  }

  const items = (rows.results ?? []).map((r) => {
    const row = hydrateRow(r);
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
      consumedAt: row.consumedAt,
      consumedDocIdxs: row.consumedDocIdxs,
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

  return c.json({
    success: true,
    data: { batchId: latest.batchId, items, summary },
  });
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
      consumedAt: hydrated.consumedAt,
      consumedDocIdxs: hydrated.consumedDocIdxs,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan-queue/:id/bytes — return the row's stored PDF/image bytes.
// Used by the supplier scan modal at "Create as DRAFT" time to upload the
// (possibly chunked) source document to /api/files so the resulting PI
// links back to its source PDF (owner ruling 2026-06-30).
//
// Auth: same gate as upload — purchase-orders/create. Returns 404 once the
// row has been consumed (bytes were NULLed during the consume step).
// ---------------------------------------------------------------------------
app.get("/:id/bytes", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const id = c.req.param("id");
  const orgId = getOrgId(c);

  let row;
  try {
    row = await c.var.DB.prepare(
      `SELECT file_bytes_b64 AS "fileBytesB64",
              mime_type      AS "mimeType",
              file_name      AS "fileName"
         FROM scan_queue
        WHERE id = ?
          AND (org_id = ? OR org_id IS NULL)`,
    )
      .bind(id, orgId)
      .first<{
        fileBytesB64: string | null;
        mimeType: string | null;
        fileName: string | null;
      }>();
  } catch (e) {
    return c.json(
      { success: false, error: `Query failed: ${(e as Error).message}` },
      500,
    );
  }
  if (!row) {
    return c.json({ success: false, error: "Scan row not found." }, 404);
  }
  if (!row.fileBytesB64) {
    return c.json(
      {
        success: false,
        error:
          "File bytes evicted — the row was already consumed or pre-dates the source-doc-link rollout.",
      },
      410,
    );
  }
  const bytes = base64ToArrayBuffer(row.fileBytesB64);
  const mime = row.mimeType || "application/pdf";
  const filename = row.fileName || "scan.pdf";
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
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
              error = NULL, attempts = 0
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
// POST /api/scan-queue/:id/consume — mark a row consumed_at = NOW() so the
// pending-batch resume endpoint no longer surfaces it. Called by the modal
// once the PI/GRN/SO has been successfully created from the row's extraction.
// Filtered by `kind/:id` is unnecessary — any caller with create perms for
// the row can flip it (same gate as upload).
//
// Body (optional): { docIdx: number } — when present, marks ONLY that doc
// within the row's rawJson.docs[] / rawJson.pos[] as consumed. The row's
// consumed_at flips only once every doc is consumed. Lets the operator
// X-delete one card from a multi-doc PDF without losing the rest.
// ---------------------------------------------------------------------------
app.post("/:id/consume", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  await ensureScanQueueTable(c.var.DB);
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const nowIso = new Date().toISOString();

  // Optional docIdx from body. Tolerate empty / non-JSON body (legacy
  // whole-row callers send no body at all).
  let docIdx: number | null = null;
  try {
    const body = await c.req.json<{ docIdx?: unknown }>().catch(() => null);
    if (body && typeof body.docIdx === "number" && Number.isInteger(body.docIdx) && body.docIdx >= 0) {
      docIdx = body.docIdx;
    }
  } catch {
    /* empty body — whole-row consume, no docIdx */
  }

  // Whole-row consume — original behaviour. Flip consumed_at directly.
  // Also NULL file_bytes_b64 — bytes were retained past 'done' so the
  // create-PI step could upload them to /api/files; now that every doc on
  // the row has been consumed, the source PDF is no longer needed locally.
  if (docIdx === null) {
    let result;
    try {
      result = await c.var.DB.prepare(
        `UPDATE scan_queue
            SET consumed_at = ?,
                file_bytes_b64 = NULL
          WHERE id = ?
            AND (org_id = ? OR org_id IS NULL)`,
      )
        .bind(nowIso, id, orgId)
        .run();
    } catch (e) {
      return c.json(
        { success: false, error: `Consume failed: ${(e as Error).message}` },
        500,
      );
    }
    const changes = (result.meta?.changes ?? 0) as number;
    if (changes === 0) {
      return c.json(
        { success: false, error: "Scan row not found." },
        404,
      );
    }
    return c.json({ success: true, data: { id, consumedAt: nowIso } });
  }

  // Per-doc consume — append docIdx to consumed_doc_idxs (dedup), and only
  // stamp consumed_at if every doc in rawJson is now accounted for.
  let row;
  try {
    row = await c.var.DB.prepare(
      `SELECT * FROM scan_queue
        WHERE id = ?
          AND (org_id = ? OR org_id IS NULL)`,
    )
      .bind(id, orgId)
      .first<Record<string, unknown>>();
  } catch (e) {
    return c.json(
      { success: false, error: `Consume read failed: ${(e as Error).message}` },
      500,
    );
  }
  if (!row) {
    return c.json({ success: false, error: "Scan row not found." }, 404);
  }
  const hydrated = hydrateRow(row);
  const current = new Set(hydrated.consumedDocIdxs);
  current.add(docIdx);
  const nextIdxs = Array.from(current).sort((a, b) => a - b);

  // Total docs in the row. Cover supplier (docs[]) AND po (pos[]) shapes.
  // Legacy single-doc rows that pre-date the multi-doc envelope still count
  // as 1 — so a single docIdx=0 consume flips the row immediately.
  let totalDocs = 1;
  if (hydrated.rawJson && typeof hydrated.rawJson === "object") {
    const rj = hydrated.rawJson as { docs?: unknown; pos?: unknown };
    if (Array.isArray(rj.docs)) totalDocs = Math.max(rj.docs.length, 1);
    else if (Array.isArray(rj.pos)) totalDocs = Math.max(rj.pos.length, 1);
  }
  const shouldFinalise = nextIdxs.length >= totalDocs;

  try {
    if (shouldFinalise) {
      // Last doc consumed — also NULL file_bytes_b64 (bytes were retained
      // past 'done' so the create-PI step could upload to /api/files).
      await c.var.DB.prepare(
        `UPDATE scan_queue
            SET consumed_doc_idxs = ?::jsonb,
                consumed_at = ?,
                file_bytes_b64 = NULL
          WHERE id = ?
            AND (org_id = ? OR org_id IS NULL)`,
      )
        .bind(JSON.stringify(nextIdxs), nowIso, id, orgId)
        .run();
    } else {
      await c.var.DB.prepare(
        `UPDATE scan_queue
            SET consumed_doc_idxs = ?::jsonb
          WHERE id = ?
            AND (org_id = ? OR org_id IS NULL)`,
      )
        .bind(JSON.stringify(nextIdxs), id, orgId)
        .run();
    }
  } catch (e) {
    return c.json(
      { success: false, error: `Consume write failed: ${(e as Error).message}` },
      500,
    );
  }
  return c.json({
    success: true,
    data: {
      id,
      docIdx,
      consumedDocIdxs: nextIdxs,
      consumedAt: shouldFinalise ? nowIso : null,
    },
  });
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
type WaitUntilContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export async function sweepStuckScans(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  ctx: WaitUntilContext | undefined,
): Promise<{ requeued: number; batches: string[] }> {
  await ensureScanQueueTable(db);
  const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
  const nowIso = new Date().toISOString();
  try {
    // Exhausted stuck rows (worker died MAX_OCR_ATTEMPTS times) → fail them so
    // they stop being re-kicked forever.
    await db
      .prepare(
        `UPDATE scan_queue
            SET status = 'failed',
                completed_at = ?,
                error = COALESCE(error, 'worker died before completing OCR')
          WHERE status = 'processing'
            AND (started_at IS NULL OR started_at < ?)
            AND COALESCE(attempts, 0) >= ?`,
      )
      .bind(nowIso, cutoff, MAX_OCR_ATTEMPTS)
      .run();
  } catch (e) {
    console.error("[scan-queue sweep] fail-exhausted failed:", (e as Error).message);
  }
  // Re-queue the still-retriable stuck rows and re-kick their batches.
  let stuck;
  try {
    stuck = await db
      .prepare(
        `SELECT id, batch_id AS "batchId"
           FROM scan_queue
          WHERE status = 'processing'
            AND (started_at IS NULL OR started_at < ?)
            AND COALESCE(attempts, 0) < ?`,
      )
      .bind(cutoff, MAX_OCR_ATTEMPTS)
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

// ---------------------------------------------------------------------------
// sweepStuckBatch — scoped self-heal for a SINGLE batch, called from the poll
// endpoints (/batch/:batchId, /pending) so an open modal recovers a stuck row
// on its very next poll tick, WITHOUT depending on an external cron. This is
// the primary recovery path on Cloudflare Pages, which can't schedule the
// CRON_SECRET sweeper (see wrangler.toml — Pages has no [triggers] crons).
//
// Re-queues any 'processing' row in this batch older than STUCK_MS (its worker
// died / the isolate was killed mid-OCR) and re-kicks processBatch only if
// something was actually freed. Best-effort: a sweep failure is swallowed so
// it can never break the poll response the modal depends on.
// ---------------------------------------------------------------------------
async function sweepStuckBatch(
  db: Env["Variables"]["DB"],
  env: Env["Bindings"],
  ctx: WaitUntilContext | undefined,
  batchId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
  const nowIso = new Date().toISOString();
  try {
    // Exhausted stuck rows — their worker died MAX_OCR_ATTEMPTS times over
    // (the caught-failure retry path never runs when the isolate is killed,
    // so the cap has to be enforced here too). Give up instead of re-kicking
    // forever.
    await db
      .prepare(
        `UPDATE scan_queue
            SET status = 'failed',
                completed_at = ?,
                error = COALESCE(error, 'worker died before completing OCR')
          WHERE batch_id = ?
            AND status = 'processing'
            AND (started_at IS NULL OR started_at < ?)
            AND COALESCE(attempts, 0) >= ?`,
      )
      .bind(nowIso, batchId, cutoff, MAX_OCR_ATTEMPTS)
      .run();
    // Still-retriable stuck rows → back to the queue for another go.
    const upd = await db
      .prepare(
        `UPDATE scan_queue
            SET status = 'queued', started_at = NULL
          WHERE batch_id = ?
            AND status = 'processing'
            AND (started_at IS NULL OR started_at < ?)
            AND COALESCE(attempts, 0) < ?`,
      )
      .bind(batchId, cutoff, MAX_OCR_ATTEMPTS)
      .run();
    if ((upd.meta?.changes ?? 0) > 0) {
      ctx?.waitUntil(processBatch(db, env, batchId));
    }
  } catch (e) {
    console.error("[scan-queue] batch sweep failed:", (e as Error).message);
  }
}

export default app;
