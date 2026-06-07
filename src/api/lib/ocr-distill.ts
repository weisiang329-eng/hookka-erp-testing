// ---------------------------------------------------------------------------
// OCR customer-rule distillation — reusable core.
//
// Phase 6 Layer 3 — auto-distill a per-customer OCR rules block from the
// gold sample pool. For one customer it: loads up to 50 gold-marked samples
// (po_scan_samples WHERE isGold = 1), refuses if fewer than 2, makes one
// Claude call, and writes the result into customers.ocrPromptRules
// (REPLACING any existing value — "regenerate from gold pool", not "merge").
//
// This logic used to live INLINE in the HTTP route
// POST /customer-rules/:customerId/distill in routes/scan-po.ts. It was
// extracted here so two callers can share it:
//   1. The manual route (still RBAC-gated by customers:update) — calls this
//      after its requirePermission check.
//   2. The weekly cron /api/internal/distill-ocr-rules (no user session) —
//      loops every customer and calls this directly.
//
// The RBAC gate is NOT part of this function — the cron has no user session.
// Auth is the caller's responsibility (route gate, or CRON_SECRET on worker).
//
// Pure of Hono context — takes a D1Database handle + the env object directly
// so it can also be invoked from tests / scripts.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Self-applying migration — adds the `ocrPromptRules` column to `customers`
// and the `isGold` column to `po_scan_samples` the first time this runs in a
// fresh isolate. Mirrors the ensureScanPoColumns pattern in scan-po.ts so
// Supabase stays forward-compatible without a separate deploy step.
let distillColumnsPromise: Promise<void> | null = null;
function ensureDistillColumns(db: DistillDb): Promise<void> {
  if (distillColumnsPromise) return distillColumnsPromise;
  distillColumnsPromise = (async () => {
    const stmts = [
      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS ocrPromptRules TEXT",
      "ALTER TABLE po_scan_samples ADD COLUMN IF NOT EXISTS isGold INTEGER NOT NULL DEFAULT 0",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).bind().run();
      } catch {
        // best-effort; column may already exist or DDL transiently rejected
      }
    }
  })();
  return distillColumnsPromise;
}

// Minimal structural DB surface — mirrors the DBLike/DBQuery types in
// scan-po.ts. Kept local so this lib has no import cycle with the route.
type DistillQuery = {
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
};
type DistillDb = {
  prepare: (sql: string) => { bind: (...args: unknown[]) => DistillQuery };
};

// Only the field this lib reads off the worker env.
type DistillEnv = { ANTHROPIC_API_KEY?: string };

type AnthropicDistillResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Outcome of one customer's distillation. Deliberately small — the cron
 * aggregates these into a {distilled, skipped, errored} summary, and the
 * route maps it back to its existing JSON response shape.
 */
export type DistillResult = {
  status: "distilled" | "skipped" | "error";
  /** Human-readable reason for skip/error (omitted on success). */
  reason?: string;
  /** Distilled rule text (present only on status === "distilled"). */
  rulesGenerated?: string;
  /** Gold samples fed to Claude (present on distilled, and on the
   *  <2-samples skip so the route can echo the count). */
  sampleCount?: number;
  tokensIn?: number;
  tokensOut?: number;
};

const DISTILL_META_PROMPT = `You are reviewing operator-confirmed correct extractions of customer Purchase Orders for a furniture manufacturer (Hookka). Your task is to write a concise customer-specific OCR rule block that captures the patterns unique to THIS customer's POs so a future OCR call applies them automatically.

Look at the patterns in the confirmed extractions below and identify what is BESPOKE TO THIS CUSTOMER:
  • Their PO number format (prefix, length, letter/digit pattern).
  • The size codes they use (e.g. "(K)", "(Q)", "K-size", "Queen", etc.).
  • Their fabric code conventions (prefix families like PC151-*, KN390-*, BO315-*).
  • Their spec-line shorthand for divan / leg / gap / drawer / no-leg phrasings.
  • Sofa module shorthand (1+1+1, 2+L, 1R+1R, "3 Seater" splits, etc.).
  • Special-order phrasings they use in handwritten notes (urgency cues, fabric overrides, backrest specials).
  • Any letterhead / header layout cues that identify them.
  • Hub / state defaults if they consistently ship to one location.
  • Quirks that conflict with the universal rules — call those out explicitly.

DO NOT restate universal rules that apply to all customers.
DO NOT enumerate every line item from the examples.
DO NOT write a generic OCR primer.
DO write 100-300 words of plain prose, focused on what is DIFFERENT about this customer.
DO use bullet points or short paragraphs. No markdown headers, no fences, no preamble, no closing.

Output ONLY the rule text. The very first character of your response must be a letter or a bullet marker (•, -, *). Anything else will be stored verbatim into the prompt and corrupt downstream extractions.`;

/**
 * Distill a per-customer OCR rule block from that customer's gold sample
 * pool and store it into customers.ocrPromptRules (replacing any existing
 * value).
 *
 * Does NOT enforce RBAC — the caller is responsible for auth.
 *
 * Cheap-skip contract: a customer with fewer than 2 gold samples is skipped
 * WITHOUT an Anthropic call, so the cron can safely iterate every customer.
 *
 * @returns a small result object: status "distilled" | "skipped" | "error".
 */
export async function distillCustomerRules(
  db: D1Database,
  env: DistillEnv,
  orgId: string,
  customerId: string,
): Promise<DistillResult> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "error",
      reason:
        "ANTHROPIC_API_KEY not configured. Run `npx wrangler secret put ANTHROPIC_API_KEY` to enable rule distillation.",
    };
  }

  const dbLike = db as unknown as DistillDb;
  await ensureDistillColumns(dbLike);

  const customer = await dbLike
    .prepare("SELECT id, code, name FROM customers WHERE id = ? AND orgId = ?")
    .bind(customerId, orgId)
    .first<{ id: string; code: string; name: string }>();
  if (!customer) {
    return { status: "error", reason: "Customer not found." };
  }

  // Sample selection: gold rows for this customer. Three ways to match:
  //   1. customerHint == customer.name (case-insensitive exact), OR
  //   2. poIdentifier starts with the customer's code, OR
  //   3. NORMALIZED prefix — the OCR saves the PO's full legal name as the
  //      hint ("Houzs Century Sdn Bhd"), but the customer record is the short
  //      name ("Houzs Century"). Strip non-alphanumerics and treat the short
  //      name as a prefix of the hint so the two reunite. BUG-2026-06-07: the
  //      old exact-only match wasted ~92% of gold samples (Carress + the
  //      "...Sdn Bhd" Houzs pool never matched, so distill ran on near-empty).
  // 50 row cap, newest first.
  const samplesRes = await dbLike
    .prepare(
      `SELECT id, correctedJson, customerHint, poIdentifier, createdAt
         FROM po_scan_samples
         WHERE isGold = 1
           AND correctedJson IS NOT NULL
           AND (
                 UPPER(customerHint) = UPPER(?)
              OR UPPER(poIdentifier) LIKE UPPER(?)
              OR regexp_replace(UPPER(COALESCE(customerHint, '')), '[^A-Z0-9]', '', 'g')
                   LIKE regexp_replace(UPPER(?), '[^A-Z0-9]', '', 'g') || '%'
           )
         ORDER BY createdAt DESC
         LIMIT 50`,
    )
    .bind(customer.name, `${customer.code}%`, customer.name)
    .all<{
      id: string;
      correctedJson: string | null;
      customerHint: string | null;
      poIdentifier: string | null;
      createdAt: string | null;
    }>();
  const rows = (samplesRes.results ?? []).filter((r) => r.correctedJson);

  // Floor at 2 — fewer than 2 samples and we refuse WITHOUT burning an API
  // call (one example isn't a pattern). This cheap skip is what makes
  // iterating every customer in the cron safe.
  if (rows.length < 2) {
    return {
      status: "skipped",
      reason: `Need at least 2 gold samples to distill rules; this customer has ${rows.length}.`,
      sampleCount: rows.length,
    };
  }

  // Pack the examples into a single user-message block. Keep them as raw
  // JSON so Claude can see the structured fields (productCode, fabricCode,
  // rawSpec, specialOrder, etc.) — that's where the patterns live.
  const examplesText = rows
    .map(
      (r, i) =>
        `Example ${i + 1} (PO: ${r.poIdentifier ?? "—"}):\n${r.correctedJson}`,
    )
    .join("\n\n");

  const userPayload =
    `Customer: ${customer.name} (code: ${customer.code})\n\n` +
    `Here are ${rows.length} confirmed correct extractions for this customer. Look at the patterns in their PO format and write the customer-specific rule block:\n\n` +
    examplesText;

  let distilledText = "";
  let errorMsg: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;

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
        max_tokens: 2048,
        // Determinism: same gold pool → same distilled rules. Matches the
        // rest of scan-po.ts.
        temperature: 0,
        system: DISTILL_META_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPayload }],
          },
        ],
      }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      errorMsg = `Anthropic ${resp.status}: ${bodyText.slice(0, 500)}`;
    } else {
      let parsedResp: AnthropicDistillResponse;
      try {
        parsedResp = JSON.parse(bodyText) as AnthropicDistillResponse;
      } catch {
        errorMsg = `Anthropic returned non-JSON: ${bodyText.slice(0, 300)}`;
        parsedResp = {};
      }
      if (parsedResp.error) {
        errorMsg = `Anthropic: ${parsedResp.error.type}: ${parsedResp.error.message}`;
      } else {
        tokensIn = parsedResp.usage?.input_tokens ?? 0;
        tokensOut = parsedResp.usage?.output_tokens ?? 0;
        const firstText =
          parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
        // The distill output is plain prose, not JSON — but Claude
        // sometimes wraps in fences anyway. Strip leading/trailing ```
        // blocks (do NOT slice to first/last brace — that would truncate
        // the prose).
        let cleaned = firstText.trim();
        const fenceRe = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/;
        const m = cleaned.match(fenceRe);
        if (m) cleaned = m[1].trim();
        distilledText = cleaned;
      }
    }
  } catch (e) {
    errorMsg = `Network/fetch error: ${(e as Error).message}`;
  }

  if (errorMsg || !distilledText) {
    return {
      status: "error",
      reason: errorMsg ?? "Claude returned empty rules.",
    };
  }

  // Soft cap — same 32k char ceiling as the PUT endpoint so the cached
  // prefix doesn't blow up if Claude produces an unexpectedly long block.
  if (distilledText.length > 32_000) {
    distilledText = distilledText.slice(0, 32_000);
  }

  // REPLACE existing rules (regenerate-from-gold-pool, not merge).
  const result = await dbLike
    .prepare("UPDATE customers SET ocrPromptRules = ? WHERE id = ? AND orgId = ?")
    .bind(distilledText, customerId, orgId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return {
      status: "error",
      reason: "Customer update failed after distillation.",
    };
  }

  return {
    status: "distilled",
    rulesGenerated: distilledText,
    sampleCount: rows.length,
    tokensIn,
    tokensOut,
  };
}

/**
 * Loop every customer in an org and distill rules for each. Per-customer
 * errors are CAUGHT so one failure cannot abort the whole run. Customers
 * with fewer than 2 gold samples are skipped cheaply (no Anthropic call).
 *
 * Used by the weekly cron /api/internal/distill-ocr-rules.
 */
export async function distillAllCustomerRules(
  db: D1Database,
  env: DistillEnv,
  limit = 200,
): Promise<{ distilled: number; skipped: number; errored: number; total: number }> {
  // Defensive cap — even if a caller passes a huge number, don't chew
  // through unbounded rows in a single Workers invocation.
  const safeLimit = Math.max(1, Math.min(limit, 1000));

  await ensureDistillColumns(db as unknown as DistillDb);

  const custRes = await db
    .prepare(
      "SELECT id, orgId FROM customers WHERE isActive = 1 ORDER BY code LIMIT ?",
    )
    .bind(safeLimit)
    .all<{ id: string; orgId: string }>();
  const customers = custRes.results ?? [];

  let distilled = 0;
  let skipped = 0;
  let errored = 0;

  for (const cust of customers) {
    try {
      const res = await distillCustomerRules(db, env, cust.orgId, cust.id);
      if (res.status === "distilled") distilled += 1;
      else if (res.status === "skipped") skipped += 1;
      else {
        errored += 1;
        console.warn(
          `[distill-ocr-rules] customer ${cust.id} (org=${cust.orgId}) error: ${res.reason ?? "unknown"}`,
        );
      }
    } catch (err) {
      // One customer's failure must not abort the whole sweep.
      errored += 1;
      console.warn(
        `[distill-ocr-rules] customer ${cust.id} (org=${cust.orgId}) threw:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { distilled, skipped, errored, total: customers.length };
}
