// ---------------------------------------------------------------------------
// Phase B.4 — File assets API.
//
// Routes:
//   POST   /api/files                  — multipart upload; stores to R2 +
//                                        records the row in file_assets.
//   GET    /api/files                  — list (filter by resourceType,
//                                        resourceId).
//   GET    /api/files/:id              — fetch metadata.
//   GET    /api/files/:id/download     — 302 to a short-lived presigned
//                                        URL (or the /stream proxy if R2
//                                        presigning isn't available).
//   GET    /api/files/:id/stream       — proxy stream the body. Used as
//                                        the fallback when presigned URLs
//                                        aren't available on the runtime.
//   DELETE /api/files/:id              — removes the row + R2 object.
//
// Behavior when R2 binding is missing:
//   Every route returns 503 with `{ ok: false, error: "file storage
//   unavailable" }`. Frontend can detect this and hide upload controls.
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
  R2BucketNotConfiguredError,
  putFile,
  getFile,
  signedDownloadUrl,
  deleteFile,
} from "../lib/r2-store";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

// Upload size guard — 50 MB ceiling. Sized for typical PDF/PNG
// attachments; anything bigger should go through a presigned-PUT direct
// upload (Phase B.4 finish).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
 * Build the R2 object key. Format:
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
  if (!c.env.FILES) {
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

  const orgId = getOrgId(c);
  const id = genId();
  const filename = file.name || "upload";
  const contentType = file.type || "application/octet-stream";
  const r2Key = buildKey({ orgId, resourceType, resourceId, id, filename });
  const uploadedBy = (
    c.get as unknown as (k: string) => string | undefined
  )("userId") ?? null;
  const uploadedAt = new Date().toISOString();

  try {
    // Upload first, DB second — if the DB write fails we have an
    // orphan object in R2 (cleanable by a sweeper job; cheaper than
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
    // Snapshot only metadata; bytes live in R2 and aren't audit-friendly.
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
    if (err instanceof R2BucketNotConfiguredError) {
      return c.json({ success: false, error: "file storage unavailable" }, 503);
    }
    console.error("[files/POST] upload failed:", err);
    // Best-effort cleanup of the R2 object since we don't know if put
    // succeeded before the DB write blew up.
    try {
      await deleteFile(c.env, r2Key);
    } catch {
      // Already gone, or R2 is transient — sweeper will catch it.
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
  if (!c.env.FILES) {
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
    if (err instanceof R2BucketNotConfiguredError) {
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
  if (!c.env.FILES) {
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
        "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      },
    });
  } catch (err) {
    if (err instanceof R2BucketNotConfiguredError) {
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
    if (err instanceof R2BucketNotConfiguredError) {
      // Without R2 we can't actually delete the bytes; still drop the
      // DB row so the user-facing list reflects the intent. The orphan
      // object will get pruned once R2 is enabled and the sweeper runs.
      console.warn(
        "[files/DELETE] R2 unavailable — dropping DB row only, leaving orphan key",
        row.r2Key,
      );
    } else {
      console.error("[files/DELETE] r2 delete failed:", err);
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
