// ---------------------------------------------------------------------------
// Announcement auto-translation — reusable core.
//
// The office posts a free-text announcement in ONE language (whatever they
// type). The shop-floor worker portal supports four languages
// (en / ms / zh / my), each worker picks theirs in localStorage. To avoid a
// per-view / per-worker translation cost, we translate ONCE on POST (and on
// edit when title/body change), store all four versions as a JSON blob on the
// row, and the worker GET hands them all back so the FE picks the right one.
//
// Translation method = the SAME bare-fetch Anthropic Claude Messages API
// pattern already used by ocr-distill.ts (model claude-sonnet-4-6,
// temperature 0, x-api-key + anthropic-version headers). NO new binding, key,
// or infra — ANTHROPIC_API_KEY is an existing configured secret. Cloudflare
// Workers AI m2m100 was considered as an on-platform fallback but rejected:
// it needs an [ai] binding + Env.AI typing for no benefit at this volume.
//
// Robustness contract (load-bearing): a Claude outage MUST NEVER block posting
// an announcement. Every entry point wraps this in try/catch and falls back to
// storing `null` translations; the worker FE then shows the original text.
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// The four worker-portal languages (mirrors WorkerLang in src/lib/worker-i18n.ts).
export const ANNOUNCEMENT_LANGS = ["en", "ms", "zh", "my"] as const;
export type AnnouncementLang = (typeof ANNOUNCEMENT_LANGS)[number];

// One translated pair.
export type TranslationPair = { title: string; body: string };

// The full stored shape — title+body for every supported language.
export type AnnouncementTranslations = Record<AnnouncementLang, TranslationPair>;

type AnthropicTranslateResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

const SYSTEM_PROMPT = `You are a translator for a furniture factory's worker-portal announcements. You receive a notice's TITLE and BODY in some language and must translate BOTH into all four target languages.

Target languages (use exactly these JSON keys):
  • en — English
  • ms — Bahasa Melayu (Malay)
  • zh — Simplified Chinese (简体中文)
  • my — Burmese (မြန်မာ)

Rules:
  • Return STRICT JSON ONLY, no commentary, no markdown fences, in exactly this shape:
    {"en":{"title":"...","body":"..."},"ms":{"title":"...","body":"..."},"zh":{"title":"...","body":"..."},"my":{"title":"...","body":"..."}}
  • Translate naturally for shop-floor workers — plain, clear, polite.
  • For the language the notice is ALREADY in, return its original text unchanged.
  • PRESERVE all numbers, dates, times, money amounts, product codes, SKUs, and proper names verbatim — do not localize or convert them.
  • PRESERVE line breaks in the body (keep \\n where the original had them).
  • If the BODY is empty, return an empty string for body in every language.
  • The very first character of your response must be "{". Anything else corrupts the stored data.`;

/**
 * Validate that a parsed object is a complete AnnouncementTranslations:
 * all four langs present, each with string title + string body. Returns the
 * typed object on success, or null if anything is missing/malformed (caller
 * then stores null → FE falls back to the original posted text).
 */
function validateTranslations(
  parsed: unknown,
): AnnouncementTranslations | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const out = {} as AnnouncementTranslations;
  for (const lang of ANNOUNCEMENT_LANGS) {
    const pair = obj[lang];
    if (!pair || typeof pair !== "object") return null;
    const p = pair as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return null;
    out[lang] = { title: p.title, body: p.body };
  }
  return out;
}

/**
 * Strip ``` / ```json fences Claude sometimes wraps JSON in, then slice to the
 * outermost {...} so leading/trailing prose can't break JSON.parse. Mirrors
 * the defensive parse in scan-po.ts / ocr-distill.ts.
 */
function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = s.match(fence);
  if (m) s = m[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

/**
 * Parse the raw Claude text into a validated translations object, or null.
 * Exported so the regression test can exercise the parse + validation without
 * a network call.
 */
export function parseTranslationsText(
  raw: string,
): AnnouncementTranslations | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  return validateTranslations(parsed);
}

/**
 * Translate a posted announcement's title + body into all four worker-portal
 * languages with ONE Claude call.
 *
 * Best-effort by contract: returns `null` (never throws) on a missing key,
 * a Claude error, a network failure, or an unparseable/incomplete response.
 * The caller stores null and the worker FE falls back to the original text —
 * so translation can NEVER block posting an announcement.
 *
 * Pure of Hono context — takes the title/body/apiKey directly so it can be
 * unit-tested.
 */
export async function translateAnnouncement(args: {
  title: string;
  body: string;
  apiKey: string | undefined;
}): Promise<AnnouncementTranslations | null> {
  const { title, body, apiKey } = args;
  // Graceful skip when the secret isn't configured (matches ocr-distill).
  if (!apiKey) return null;
  // Nothing to translate.
  if (!title.trim() && !body.trim()) return null;

  const userPayload = JSON.stringify({ title, body });

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
        // 4 languages × {title,body}, Burmese is token-heavy — 4096 keeps a
        // realistic shop-floor notice from truncating (truncation → invalid
        // JSON → silent fallback to the original text).
        max_tokens: 4096,
        // Determinism: same notice → same translation.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Translate this announcement (title + body) into all four target languages:\n\n${userPayload}`,
              },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) return null;
    const bodyText = await resp.text();
    let parsedResp: AnthropicTranslateResponse;
    try {
      parsedResp = JSON.parse(bodyText) as AnthropicTranslateResponse;
    } catch {
      return null;
    }
    if (parsedResp.error) return null;
    const firstText =
      parsedResp.content?.find((b) => b.type === "text")?.text ?? "";
    return parseTranslationsText(firstText);
  } catch {
    // Network / fetch error — never bubble up to the POST handler.
    return null;
  }
}
