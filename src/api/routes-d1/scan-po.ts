// ---------------------------------------------------------------------------
// scan-po.ts — Claude-powered Customer PO OCR route.
//
// Two endpoints:
//   POST /api/scan-po/extract             — upload a PDF, get structured JSON
//   POST /api/scan-po/samples/:id/confirm — save the user-corrected JSON
//                                            as a few-shot example
//
// Setup:
//   npx wrangler secret put ANTHROPIC_API_KEY   (enter your key when prompted)
//
// Monitor:
//   https://dash.cloudflare.com/.../pages/settings/environment-variables
//
// Costs: ~$0.01-0.05 per PO page using claude-sonnet-4-6.
//
// The Anthropic Messages API natively accepts PDF document content under
// Sonnet 4.6; no `anthropic-beta: pdfs-2024-09-25` header is required.
//
// Every extraction (including failures) is logged to po_scan_samples so
// debugging is possible even for broken PDFs. The most recent user-
// corrected JSON rows are injected as few-shot examples on subsequent
// calls to improve extraction quality over time.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32MB cap — matches Anthropic limit.
const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

type SampleRow = {
  id: string;
  correctedJson: string | null;
};

const EXTRACTION_PROMPT = `Extract this furniture Purchase Order into strict JSON. If a field isn't present, use null.
Schema:
{
  "customerPO": string,
  "customerName": string,
  "customerState": string | null,
  "deliveryDate": "YYYY-MM-DD" | null,
  "items": [{
    "productCode": string,
    "description": string | null,
    "quantity": number,
    "sizeLabel": string | null,
    "fabricCode": string | null,
    "divanHeightInches": number | null,
    "legHeightInches": number | null,
    "gapInches": number | null,
    "specialOrder": string | null,
    "unitPrice": number | null
  }]
}
Return ONLY JSON, no markdown fences, no prose.`;

function genId(): string {
  return `pos-${crypto.randomUUID().slice(0, 8)}`;
}

// ArrayBuffer -> base64. Workers don't expose Node's Buffer; the chunked
// loop keeps stack usage bounded for large files.
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

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  // Strip ```json ... ``` or ``` ... ``` if Claude slips and adds them.
  const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = trimmed.match(fenceRe);
  return (m ? m[1] : trimmed).trim();
}

type ExtractedItem = {
  productCode: string;
  description: string | null;
  quantity: number;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  specialOrder: string | null;
  unitPrice: number | null;
};

type ExtractedPO = {
  customerPO: string;
  customerName: string;
  customerState: string | null;
  deliveryDate: string | null;
  items: ExtractedItem[];
};

type AnthropicResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
};

// ---------------------------------------------------------------------------
// POST /api/scan-po/extract
// ---------------------------------------------------------------------------
app.post("/extract", async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      {
        success: false,
        error:
          "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable PO scanning.",
      },
      500,
    );
  }

  // Multipart parse — Hono uses the Workers native FormData.
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

  // File guards.
  if (file.size > MAX_PDF_BYTES) {
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
  if (!isPdf) {
    return c.json(
      { success: false, error: "Only PDF files are accepted." },
      400,
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdfBase64 = toBase64(arrayBuffer);

  // Few-shot examples — last 3 user-corrected samples.
  const examples = await c.env.DB.prepare(
    "SELECT id, correctedJson FROM po_scan_samples WHERE correctedJson IS NOT NULL ORDER BY createdAt DESC LIMIT 3",
  )
    .all<SampleRow>()
    .catch(() => ({ results: [] as SampleRow[] }));

  let promptText = EXTRACTION_PROMPT;
  if (examples.results && examples.results.length > 0) {
    const shots = examples.results
      .map((r, i) => `Example ${i + 1} (corrected):\n${r.correctedJson}`)
      .join("\n\n");
    promptText = `${EXTRACTION_PROMPT}\n\nFor reference, here are past correctly-extracted POs. Use the same field conventions:\n\n${shots}`;
  }

  const sampleId = genId();
  const createdBy = (c.get("userId" as never) as string | undefined) ?? null;
  const customerHintGuess = name.split(/[-_ .]/)[0]?.slice(0, 40) ?? null;

  // Call Anthropic. Wrap in try/catch so we can always log to po_scan_samples.
  let claudeText = "";
  let parseOk = false;
  let parsed: ExtractedPO | null = null;
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
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              { type: "text", text: promptText },
            ],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        const firstText = parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        claudeText = stripJsonFences(firstText);
        try {
          parsed = JSON.parse(claudeText) as ExtractedPO;
          parseOk = true;
        } catch (e) {
          errorMsg = `Claude returned invalid JSON: ${(e as Error).message}. Raw: ${claudeText.slice(0, 300)}`;
        }
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  // Always log — even failures — to po_scan_samples for debugging.
  const raw = parseOk ? claudeText : JSON.stringify({ error: errorMsg, claudeText });
  const poIdentifier = parsed?.customerPO ?? null;
  const customerHint = parsed?.customerName ?? customerHintGuess;

  try {
    await c.env.DB.prepare(
      `INSERT INTO po_scan_samples (id, customerHint, poIdentifier, rawExtracted, correctedJson, createdBy)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
      .bind(sampleId, customerHint, poIdentifier, raw, createdBy)
      .run();
  } catch (e) {
    // D1 down shouldn't mask the real extraction failure — swallow + log.
    console.error("po_scan_samples insert failed:", (e as Error).message);
  }

  if (!parseOk || !parsed) {
    return c.json(
      {
        success: false,
        error: errorMsg ?? "Extraction failed.",
        sampleId,
      },
      502,
    );
  }

  return c.json({
    success: true,
    data: {
      sampleId,
      extracted: parsed,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/scan-po/samples/:id/confirm
// ---------------------------------------------------------------------------
app.post("/samples/:id/confirm", async (c) => {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ success: false, error: "Missing sample id." }, 400);
  }

  let body: { correctedJson?: unknown };
  try {
    body = (await c.req.json()) as { correctedJson?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body." }, 400);
  }

  if (body.correctedJson === undefined) {
    return c.json({ success: false, error: "Missing `correctedJson`." }, 400);
  }

  // Store as a JSON-serialized string. Accept both a raw object and a
  // pre-stringified one — frontend sends the object.
  const payload =
    typeof body.correctedJson === "string"
      ? body.correctedJson
      : JSON.stringify(body.correctedJson);

  const result = await c.env.DB.prepare(
    "UPDATE po_scan_samples SET correctedJson = ? WHERE id = ?",
  )
    .bind(payload, id)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json(
      { success: false, error: "Sample not found or update failed." },
      404,
    );
  }

  return c.json({ success: true });
});

export default app;
