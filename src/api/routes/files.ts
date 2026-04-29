// ---------------------------------------------------------------------------
// Phase B.4 — File assets API.
//
// Storage backend: Supabase Storage (was Cloudflare R2 before the
// storage-supabase-migration refactor). The wrapper module retains the
// historic R2-flavoured names — putFile / getFile / signedDownloadUrl /
// deleteFile — so route logic didn't change shape, only the import path.
//
// Routes:
//   POST   /api/files                  — multipart upload; stores to Supabase
//                                        Storage + records the row in file_assets.
//   GET    /api/files                  — list (filter by resourceType,
//                                        resourceId).
//   GET    /api/files/:id              — fetch metadata.
//   GET    /api/files/:id/download     — 302 to a short-lived presigned
//                                        URL (or the /stream proxy if signing
//                                        fails).
//   GET    /api/files/:id/stream       — proxy stream the body. Used as
//                                        the fallback when presigned URLs
//                                        aren't available.
//   DELETE /api/files/:id              — removes the row + storage object.
//
// Behavior when Supabase Storage isn't configured:
//   Every route returns 503 with `{ ok: false, error: "file storage
//   unavailable" }`. Frontend can detect this and hide upload controls.
//
// Persistence note: the DB column is still named `r2Key` / `r2_key`. We
// kept the column name to avoid a data-migrating schema change for what
// is effectively just an opaque object identifier — its semantic meaning
// is "storage object key", and the underlying backend is now Supabase
// Storage. Renaming the column is tracked as a follow-up.
//
// The migrations live at:
//   migrations/0055_file_assets.sql           (D1 source-of-truth schema)
//   migrations-postgres/0055_file_assets.sql  (Supabase mirror)
// Both stay in sync — the SupabaseAdapter adapter routes camelCase queries to
// snake_case columns via column-rename-map.json (see lib/supabase-compat.ts).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "../lib/tenant";
import {
  SupabaseStorageNotConfiguredError,
  putFile,
  getFile,
  signedDownloadUrl,
  deleteFile,
} from "../lib/supabase-storage";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

// Upload size guard — 50 MB ceiling. Sized for typical PDF/PNG
// attachments; anything bigger should go through a presigned-PUT direct
// upload (Phase B.4 finish).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Allowlist of MIME types we accept. Adding here is a deliberate decision —
// HTML/SVG/JS would let an attacker host script in the same origin if
// they tricked a victim into opening the /stream URL inline. The list
// covers everything the existing UI uploads (POD photos, BOM PDFs,
// service-case attachments).
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

// Magic-byte signatures for the allowed MIME types. We enforce that the
// declared `file.type` matches what the bytes actually look like so a
// malicious client can't upload an HTML payload labelled as image/png.
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  // WebP: RIFF....WEBP — 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  // PDF: %PDF — 25 50 44 46
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
    return "application/pdf";
  // HEIC/HEIF: ftypheic / ftypheix / ftypmif1 / ftypmsf1 etc. — bytes 4-7
  // are "ftyp", bytes 8-11 hint the brand. We don't strictly verify the
  // brand here; presence of an ISO-BMFF "ftyp" box is a solid signal.
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return "image/heic";
  return null;
}

// Map of which sniffed MIME values are acceptable substitutes for a
// declared MIME — handles benign mismatches like client declaring
// image/jpg vs sniffer returning image/jpeg.
function mimeMatches(declared: string, sniffed: string): boolean {
  if (declared === sniffed) return true;
  if (declared === "image/jpg" && sniffed === "image/jpeg") return true;
  if (declared === "image/heif" && sniffed === "image/heic") return true;
  return false;
}

type FileAssetRow = {
  id: string;
  resourceType: string;
  resourceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
  uploadedBy: string | null;
  uploadedAt: string;
  orgId: string;
};

function genId(): string {
  return `fa-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Build the storage object key. Format:
 *   <orgId>/<resourceType>/<resourceId>/<id>-<filename>
 *
 * orgId-prefixed so even an admin tool that walks the bucket can't
 * cross-list tenants by accident; resourceType+resourceId are the
 * folder hierarchy a future admin browser surfaces; the id+filename
 * tail keeps deletes idempotent and lets ops see what they're about
 * to delete from the bucket listing.
 */
function buildKey(parts: {
  orgId: string;
  resourceType: string;
  resourceId: string;
  id: string;
  filename: string;
}): string {
  // Strip any path traversal hijinks from filename — only keep basename.
  const basename = parts.filename.split(/[\\/]/).pop() || "file";
  return `${parts.orgId}/${parts.resourceType}/${parts.resourceId}/${parts.id}-${basename}`;
}

// ---------------------------------------------------------------------------
// POST /api/files — multipart upload
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "files", "create");
  if (denied) return denied;
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: "invalid multipart body" }, 400);
  }

  const file = form.get("file");
  const resourceType = String(form.get("resourceType") ?? "").trim();
  const resourceId = String(form.get("resourceId") ?? "").trim();

  if (!(file instanceof File)) {
    return c.json({ success: false, error: "file field required" }, 400);
  }
  if (!resourceType || !resourceId) {
    return c.json(
      { success: false, error: "resourceType and resourceId are required" },
      400,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      {
        success: false,
        error: `file exceeds max ${MAX_UPLOAD_BYTES} bytes`,
      },
      413,
    );
  }

  const declaredType = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(declaredType)) {
    return c.json(
      {
        success: false,
        error: `file type not allowed: ${declaredType}`,
      },
      400,
    );
  }

  // Magic-byte sniff on the first 16 bytes. Reject if the declared type
  // doesn't match the actual content — closes the path where a malicious
  // client uploads HTML+JS labelled as image/png and later serves the
  // stream URL to a victim.
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const sniffed = sniffMime(head);
  if (!sniffed || !mimeMatches(declaredType, sniffed)) {
    return c.json(
      {
        success: false,
        error: "file content does not match declared type",
      },
      400,
    );
  }

  const orgId = getOrgId(c);
  const id = genId();
  const filename = file.name || "upload";
  // Use the sniffed MIME for storage so a client lying about the type can't
  // poison the served Content-Type later.
  const contentType = sniffed;
  const r2Key = buildKey({ orgId, resourceType, resourceId, id, filename });
  const uploadedBy = (
    c.get as unknown as (k: string) => string | undefined
  )("userId") ?? null;
  const uploadedAt = new Date().toISOString();

  try {
    // Upload first, DB second — if the DB write fails we have an
    // orphan object in storage (cleanable by a sweeper job; cheaper than
    // an orphan DB row pointing at nothing).
    await putFile(c.env, r2Key, await file.arrayBuffer(), contentType);

    await c.var.DB.prepare(
      `INSERT INTO file_assets
         (id, resourceType, resourceId, filename, contentType, sizeBytes,
          r2Key, uploadedBy, uploadedAt, orgId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
      )
      .run();

    // Sprint 2 task 5 — emit one audit_events row on every successful upload.
    // Snapshot only metadata; bytes live in storage and aren't audit-friendly.
    await emitAudit(c, {
      resource: "files",
      resourceId: id,
      action: "create",
      after: {
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        sizeBytes: file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
      },
    });

    return c.json({
      success: true,
      data: {
        id,
        resourceType,
        resourceId,
        filename,
        contentType,
        sizeBytes: file.size,
        r2Key,
        uploadedBy,
        uploadedAt,
        orgId,
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/POST] upload failed:", err);
    // Best-effort cleanup of the storage object since we don't know if put
    // succeeded before the DB write blew up.
    try {
      await deleteFile(c.env, r2Key);
    } catch {
      // Already gone, or storage is transient — sweeper will catch it.
    }
    return c.json({ success: false, error: "upload failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/files?resourceType=&resourceId=
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");

  let sql = "SELECT * FROM file_assets WHERE orgId = ?";
  const binds: unknown[] = [orgId];
  if (resourceType) {
    sql += " AND resourceType = ?";
    binds.push(resourceType);
  }
  if (resourceId) {
    sql += " AND resourceId = ?";
    binds.push(resourceId);
  }
  sql += " ORDER BY uploadedAt DESC LIMIT 500";

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<FileAssetRow>();
  return c.json({ success: true, data: res.results ?? [] });
});

// ---------------------------------------------------------------------------
// GET /api/files/:id — metadata
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, data: row });
});

// ---------------------------------------------------------------------------
// GET /api/files/:id/download — 302 to a presigned URL.
// ---------------------------------------------------------------------------
app.get("/:id/download", async (c) => {
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  try {
    const url = await signedDownloadUrl(c.env, row.r2Key, 300);
    if (url) return c.redirect(url, 302);
    // Presigning unavailable on this runtime — fall through to stream proxy.
    return c.redirect(`/api/files/${id}/stream`, 302);
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/download] failed:", err);
    return c.json({ success: false, error: "download failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/files/:id/stream — proxy stream (fallback when presigning is
// not available on this runtime).
// ---------------------------------------------------------------------------
app.get("/:id/stream", async (c) => {
  if (!c.env.SUPABASE_PROJECT_REF || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ success: false, error: "file storage unavailable" }, 503);
  }
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  try {
    const obj = await getFile(c.env, row.r2Key);
    if (!obj) return c.json({ success: false, error: "Not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
        // Force download — browser doesn't try to render HTML/SVG inline
        // even if a stale row from before the upload allowlist landed
        // somehow stored such content.
        "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
        // Belt-and-braces: tell the browser not to MIME-sniff in case the
        // upload validator missed a polyglot file.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/stream] failed:", err);
    return c.json({ success: false, error: "stream failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/files/:id — removes row + R2 object
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "files", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const orgId = getOrgId(c);
  const row = await c.var.DB.prepare(
    "SELECT * FROM file_assets WHERE id = ? AND orgId = ?",
  )
    .bind(id, orgId)
    .first<FileAssetRow>();
  if (!row) return c.json({ success: false, error: "Not found" }, 404);

  try {
    await deleteFile(c.env, row.r2Key);
  } catch (err) {
    if (err instanceof SupabaseStorageNotConfiguredError) {
      // Without storage credentials we can't actually delete the bytes;
      // still drop the DB row so the user-facing list reflects the intent.
      // The orphan object will get pruned once storage is configured and
      // the sweeper runs.
      console.warn(
        "[files/DELETE] storage unavailable — dropping DB row only, leaving orphan key",
        row.r2Key,
      );
    } else {
      console.error("[files/DELETE] storage delete failed:", err);
      return c.json({ success: false, error: "delete failed" }, 500);
    }
  }

  await c.var.DB.prepare("DELETE FROM file_assets WHERE id = ? AND orgId = ?")
    .bind(id, orgId)
    .run();

  // Sprint 2 task 5 — emit audit_events row on every successful delete.
  await emitAudit(c, {
    resource: "files",
    resourceId: id,
    action: "delete",
    before: row,
  });

  return c.json({ success: true });
});

export default app;
