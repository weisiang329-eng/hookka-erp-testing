// ---------------------------------------------------------------------------
// Supplier-document OCR — Phase 2 (backend extract).
//
// The supplier-side twin of routes/scan-po.ts. Where scan-po reads a CUSTOMER's
// purchase order to seed a Sales Order, this reads a SUPPLIER's delivery note /
// invoice to seed a Goods Received Note (GRN) or a Purchase Invoice (PI). It
// shares the same self-evolving loop:
//
//   POST /api/scan-supplier/extract              — Claude vision → structured lines
//   POST /api/scan-supplier/samples/:id/confirm  — save the operator-corrected JSON
//                                                  (+ optional gold-mark → distill)
//
// Per-supplier learning lives in ocr-distill.ts (distillSupplierRules): gold
// samples in `supplier_scan_samples` distil into `suppliers.ocrPromptRules`,
// which this route injects back into the prompt so every supplier teaches the
// OCR its own document format over time (Phase 1, already shipped).
//
// Unlike scan-po (PDF only) this also accepts a photo (image/*) — supplier
// delivery notes are often a paper slip snapped on a phone at the loading bay.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { distillSupplierRules } from "../lib/ocr-distill";

const app = new Hono<Env>();

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function genId(): string {
  return `sss-${crypto.randomUUID().slice(0, 8)}`;
}

// ArrayBuffer -> base64 without Node's Buffer (Workers). Chunked so the stack
// stays bounded on a large file. Copied from scan-po.ts (kept local so the two
// scanners don't couple).
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

// Claude sometimes wraps JSON in ```fences``` or prefixes a "Looking at the
// document…" preamble despite the instruction. Recover the {...} span rather
// than fail the whole extraction.
function stripJsonFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first > 0 || (first >= 0 && last < t.length - 1)) {
    if (first >= 0 && last > first) t = t.slice(first, last + 1);
  }
  return t;
}

type AnthropicResponse = {
  content?: { type: string; text?: string }[];
  usage?: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
};

type ExtractedLine = {
  supplierCode?: string | null;
  description?: string | null;
  qty?: number | null;
  uom?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
};
type ExtractionResult = {
  supplierName?: string | null;
  docType?: string | null;
  docNo?: string | null;
  docDate?: string | null;
  currency?: string | null;
  lines?: ExtractedLine[];
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
};

// Robust numeric coercion. Despite the temperature-0 prompt, OCR output drifts:
// "1,200.50", "RM 50.00", "12 pcs", "" — all of which would poison downstream
// qty/price math (NaN, or a string concatenated into a sum). Strip everything
// but digits / dot / minus and parse; un-parseable ⇒ null (never a guess).
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v).trim() || null;

// Normalise whatever Claude returned into a clean, type-safe ExtractionResult:
// tolerate `items` as an alias for `lines`, coerce every number, trim strings,
// and drop fully-empty noise rows. One choke point so the GRN/PI side never
// sees a stringy qty or a half-shaped line. This is the "做稳一点" guard.
function sanitizeExtraction(
  raw: ExtractionResult & { items?: ExtractedLine[] },
): ExtractionResult {
  const rawLines = Array.isArray(raw.lines)
    ? raw.lines
    : Array.isArray(raw.items)
      ? raw.items
      : [];
  const lines: ExtractedLine[] = rawLines
    .map((l) => ({
      supplierCode: str(l?.supplierCode),
      description: str(l?.description),
      qty: num(l?.qty),
      uom: str(l?.uom),
      unitPrice: num(l?.unitPrice),
      amount: num(l?.amount),
    }))
    .filter((l) => l.description || l.supplierCode || l.qty != null);
  return {
    supplierName: str(raw.supplierName),
    docType: str(raw.docType),
    docNo: str(raw.docNo),
    docDate: str(raw.docDate),
    currency: str(raw.currency) ?? "MYR",
    lines,
    subtotal: num(raw.subtotal),
    tax: num(raw.tax),
    total: num(raw.total),
  };
}

const SYSTEM_PROMPT = `You are an OCR extraction engine for a furniture manufacturer (Hookka) in Malaysia. You read a SUPPLIER's document — a delivery order / delivery note (DO) or a tax invoice — and return the line items so the operator can build a Goods Received Note or a Purchase Invoice.

You will be given the document (PDF or photo). Extract EXACTLY what is printed. Do not invent, do not "correct" the supplier's figures, do not compute totals the document doesn't show.

EXTRACTION RULES
- supplierName: the supplier's company name from the letterhead (the SENDER / seller — NOT "Hookka", who is the buyer/recipient).
- docType: "DELIVERY_NOTE" if it is a delivery order/note (no prices, or "D/O"), "INVOICE" if it is a tax invoice (has prices + invoice no.), else "OTHER".
- docNo: the supplier's own document number (their DO no. or invoice no.), verbatim incl. any prefix.
- docDate: ISO YYYY-MM-DD. Convert DD/MM/YYYY (Malaysian convention) correctly — 03/06/2026 is 2026-06-03.
- currency: ISO code, default "MYR" if a Malaysian RM document doesn't say otherwise.
- lines[]: one object per goods line. Skip non-goods rows (subtotal, SST, rounding, freight-as-note, "Thank you" lines).
    - supplierCode: the supplier's item / material code if printed (the code in their own catalogue), else null.
    - description: the item description text, trimmed, single line.
    - qty: numeric quantity delivered/billed. Strip thousands separators.
    - uom: unit of measure as printed (PCS, ROLL, M, MTR, KG, SET, UNIT...). null if absent.
    - unitPrice: numeric unit price if shown (invoices), else null (delivery notes usually omit price).
    - amount: numeric line amount if shown, else null.
- subtotal / tax / total: the document's footer figures if present, else null. tax = SST/GST amount.

NUMBERS: plain numbers, no currency symbol, no commas. Use a dot decimal. If a field is genuinely absent, use null — never guess.

OUTPUT: VALID JSON ONLY, this exact shape, no preamble, no markdown, no chain-of-thought. First character '{', last character '}':
{"supplierName": string|null, "docType": "DELIVERY_NOTE"|"INVOICE"|"OTHER", "docNo": string|null, "docDate": string|null, "currency": string|null, "lines": [{"supplierCode": string|null, "description": string|null, "qty": number|null, "uom": string|null, "unitPrice": number|null, "amount": number|null}], "subtotal": number|null, "tax": number|null, "total": number|null}`;

// Build the per-supplier rule block (Phase 1's distilled output) for the prompt.
function formatSupplierRules(
  supplierName: string | null,
  rules: string | null,
): string {
  const body = (rules ?? "").trim();
  if (!supplierName || !body) return "";
  return `SUPPLIER-SPECIFIC RULES — ${supplierName}\n(Apply these; they were learned from this supplier's past documents.)\n${body}`;
}

// ---------------------------------------------------------------------------
// POST /api/scan-supplier/extract
// multipart/form-data: file=<pdf|image>, supplierId?, supplierName?, poContext?
// ---------------------------------------------------------------------------
app.post("/extract", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        success: false,
        error:
          "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable supplier-document scanning.",
      },
      500,
    );
  }

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
  const base64 = toBase64(arrayBuffer);
  const orgId = getOrgId(c);

  const supplierId =
    (formData.get("supplierId") as string | null)?.trim() || null;
  const poContext = (formData.get("poContext") as string | null)?.trim() || "";
  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;

  // Resolve the supplier (for its learned rules + the sample hint). Prefer the
  // explicit supplierId the GRN/PI page passes; fall back to a name hint.
  let supplierName =
    (formData.get("supplierName") as string | null)?.trim() || null;
  let supplierRules: string | null = null;
  if (supplierId) {
    try {
      const sup = await c.var.DB.prepare(
        "SELECT name, ocrPromptRules FROM suppliers WHERE id = ? AND orgId = ?",
      )
        .bind(supplierId, orgId)
        .first<{ name: string | null; ocrPromptRules: string | null }>();
      if (sup) {
        supplierName = supplierName || sup.name;
        supplierRules = sup.ocrPromptRules;
      }
    } catch {
      // ocrPromptRules column may not exist yet on an un-distilled instance.
    }
  }
  const supplierHint =
    supplierName || name.split(/[-_ .]/)[0]?.slice(0, 40) || null;

  // Cached prefix = system prompt + this supplier's learned rules. Stable
  // across requests so Anthropic prompt-caching discounts repeat scans.
  const rulesText = formatSupplierRules(supplierName, supplierRules);
  const cachedPrefix = rulesText
    ? `${SYSTEM_PROMPT}\n\n${rulesText}`
    : SYSTEM_PROMPT;

  // Few-shot: operator-confirmed extractions for THIS supplier (gold first).
  let fewShotText = "";
  try {
    const examples = await c.var.DB.prepare(
      `SELECT correctedJson, isGold
         FROM supplier_scan_samples
        WHERE correctedJson IS NOT NULL
          AND (orgId = ? OR orgId IS NULL)
          AND (
                UPPER(COALESCE(supplierHint,'')) = UPPER(?)
             OR regexp_replace(UPPER(COALESCE(supplierHint,'')), '[^A-Z0-9]', '', 'g')
                  LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
          )
        ORDER BY COALESCE(isGold,0) DESC, createdAt DESC
        LIMIT 3`,
    )
      .bind(orgId, supplierHint ?? "", supplierHint ?? "")
      .all<{ correctedJson: string | null; isGold: number | null }>();
    const rows = (examples.results ?? []).filter((r) => r.correctedJson);
    if (rows.length > 0) {
      const blocks = rows
        .map(
          (r, i) =>
            `Example ${i + 1} (${r.isGold ? "gold reference" : "operator-confirmed"}):\n${r.correctedJson}`,
        )
        .join("\n\n");
      fewShotText = `FEW-SHOT EXAMPLES (apply the same field conventions):\n\n${blocks}`;
    }
  } catch {
    // Best-effort — table may not exist yet (distil schema is lazy).
  }

  const mediaBlock = isPdf
    ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      }
    : {
        type: "image",
        source: {
          type: "base64",
          media_type: (mime || "image/jpeg") as string,
          data: base64,
        },
      };

  let claudeText = "";
  let parsed: ExtractionResult | null = null;
  let errorMsg: string | null = null;

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        // temperature 0 → deterministic OCR (same doc ⇒ same output), so a
        // wrong field is a reproducible prompt-fixable bug, not a flaky lottery.
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: cachedPrefix,
                cache_control: { type: "ephemeral" },
              },
              ...(fewShotText ? [{ type: "text", text: fewShotText }] : []),
              ...(poContext
                ? [
                    {
                      type: "text",
                      text: `RECEIVING AGAINST THIS PURCHASE ORDER (use the codes/descriptions to align the supplier's lines; keep the supplier's own qty/price):\n${poContext}`,
                    },
                  ]
                : []),
              mediaBlock,
              {
                type: "text",
                text: "Extract the supplier document above per the rules. Respond with VALID JSON ONLY — first character '{', last character '}', no preamble, no markdown fences.",
              },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse = {};
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else if (!errorMsg) {
        const firstText =
          parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        claudeText = stripJsonFences(firstText);
        try {
          const raw = JSON.parse(claudeText) as ExtractionResult & {
            items?: ExtractedLine[];
          };
          parsed = sanitizeExtraction(raw);
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  // Persist the scan as a sample — raw extraction now, correctedJson later when
  // the operator confirms. Feeds distillSupplierRules. Best-effort; a sample
  // write failure must not fail the extraction the operator is waiting on.
  const sampleId = genId();
  try {
    const nowIso = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO supplier_scan_samples
         (id, orgId, supplierId, supplierHint, docIdentifier, docType, rawJson, correctedJson, isGold, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    )
      .bind(
        sampleId,
        orgId,
        supplierId,
        supplierHint,
        parsed?.docNo ?? null,
        parsed?.docType ?? null,
        parsed ? JSON.stringify(parsed) : claudeText || null,
        createdBy,
        nowIso,
      )
      .run();
  } catch (e) {
    console.error("supplier_scan_samples insert failed:", (e as Error).message);
  }

  if (!parsed) {
    return c.json(
      { success: false, error: errorMsg ?? "Extraction failed.", sampleId },
      502,
    );
  }
  return c.json({ success: true, data: parsed, sampleId });
});

// ---------------------------------------------------------------------------
// POST /api/scan-supplier/samples/:id/confirm
// body: { correctedJson: object|string, gold?: boolean }
// Stores the operator-corrected extraction; gold:true marks it a reference and
// re-distils this supplier's rules immediately (waitUntil) so the next scan is
// smarter without waiting for the weekly cron.
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
  // Fire-and-forget; never let a distil hiccup fail the confirm.
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
