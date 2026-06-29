// ---------------------------------------------------------------------------
// Supplier-document OCR — Phase 2 (backend extract).
//
// HTTP layer only — prompt-building + Anthropic call + JSON parse +
// sample insert live in src/api/lib/scan-engine.ts (shared with the
// background queue worker, routes/scan-queue.ts).
//
// Two endpoints:
//   POST /api/scan-supplier/extract              — Claude vision → structured lines
//   POST /api/scan-supplier/samples/:id/confirm  — save the operator-corrected JSON
//                                                  (+ optional gold-mark → distill)
//
// Per-supplier learning lives in ocr-distill.ts (distillSupplierRules): gold
// samples in `supplier_scan_samples` distil into `suppliers.ocrPromptRules`,
// which the engine injects back into the prompt so every supplier teaches the
// OCR its own document format over time.
//
// Unlike scan-po (PDF only) this also accepts a photo (image/*) — supplier
// delivery notes are often a paper slip snapped on a phone at the loading bay.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { distillSupplierRules } from "../lib/ocr-distill";
import { runExtract } from "../lib/scan-engine";

const app = new Hono<Env>();

const MAX_FILE_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// POST /api/scan-supplier/extract
// multipart/form-data: file=<pdf|image>, supplierId?, supplierName?, poContext?
// ---------------------------------------------------------------------------
app.post("/extract", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (e) {
    return c.json(
      { success: false, error: `Invalid multipart body: ${(e as Error).message}` },
      400,
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ success: false, error: "Missing `file` field." }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return c.json(
      {
        success: false,
        error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 32MB.`,
      },
      400,
    );
  }
  const mime = file.type || "";
  const name = file.name || "";
  const isPdf = mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(name);
  if (!isPdf && !isImage) {
    return c.json(
      { success: false, error: "Only PDF or image files are accepted." },
      400,
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const orgId = getOrgId(c);
  const supplierId =
    (formData.get("supplierId") as string | null)?.trim() || null;
  const supplierName =
    (formData.get("supplierName") as string | null)?.trim() || null;
  const poContext =
    (formData.get("poContext") as string | null)?.trim() || "";
  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;

  const result = await runExtract(c.var.DB, c.env, {
    kind: "supplier",
    bytes: arrayBuffer,
    mimeType: mime,
    fileName: name,
    orgId,
    createdBy,
    supplierId,
    supplierName,
    poContext,
    // Legacy route writes a sample for the learning loop.
    recordSample: true,
  });

  if (!result.ok) {
    return c.json(
      { success: false, error: result.error, sampleId: result.sampleId },
      502,
    );
  }
  return c.json({ success: true, data: result.data, sampleId: result.sampleId });
});

// ---------------------------------------------------------------------------
// POST /api/scan-supplier/samples/:id/confirm
// body: { correctedJson: object|string, gold?: boolean }
// ---------------------------------------------------------------------------
app.post("/samples/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  const id = c.req.param("id");
  let body: { correctedJson?: unknown; gold?: unknown };
  try {
    body = (await c.req.json()) as { correctedJson?: unknown; gold?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }
  if (body.correctedJson === undefined) {
    return c.json({ success: false, error: "Missing `correctedJson`." }, 400);
  }
  const correctedJson =
    typeof body.correctedJson === "string"
      ? body.correctedJson
      : JSON.stringify(body.correctedJson);
  const gold = body.gold === true ? 1 : 0;

  const orgId = getOrgId(c);
  let updated;
  try {
    updated = await c.var.DB.prepare(
      "UPDATE supplier_scan_samples SET correctedJson = ?, isGold = ? WHERE id = ? AND (orgId = ? OR orgId IS NULL)",
    )
      .bind(correctedJson, gold, id, orgId)
      .run();
  } catch (e) {
    return c.json(
      { success: false, error: `Save failed: ${(e as Error).message}` },
      500,
    );
  }
  const changed =
    (updated as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changed === 0) {
    return c.json({ success: false, error: "Sample not found." }, 404);
  }

  // Gold-mark → re-distil this supplier's rules now (don't wait for the cron).
  let distillQueued = false;
  if (gold === 1) {
    try {
      const row = await c.var.DB.prepare(
        "SELECT supplierId, supplierHint FROM supplier_scan_samples WHERE id = ?",
      )
        .bind(id)
        .first<{ supplierId: string | null; supplierHint: string | null }>();
      let supId = row?.supplierId ?? null;
      if (!supId && row?.supplierHint) {
        const sup = await c.var.DB.prepare(
          `SELECT id FROM suppliers
            WHERE orgId = ?
              AND regexp_replace(UPPER(name), '[^A-Z0-9]', '', 'g')
                  LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
            LIMIT 1`,
        )
          .bind(orgId, row.supplierHint)
          .first<{ id: string }>();
        supId = sup?.id ?? null;
      }
      if (supId) {
        c.executionCtx?.waitUntil(
          distillSupplierRules(c.var.DB, c.env, orgId, supId)
            .then((r) => {
              if (r.status === "error")
                console.warn(
                  `[scan-supplier gold→distill] ${supId}: ${r.reason ?? "unknown"}`,
                );
            })
            .catch((e) =>
              console.warn("[scan-supplier gold→distill] threw:", e),
            ),
        );
        distillQueued = true;
      }
    } catch (e) {
      console.warn("[scan-supplier gold→distill] dispatch skipped:", e);
    }
  }

  return c.json({ success: true, distillQueued });
});

export default app;
