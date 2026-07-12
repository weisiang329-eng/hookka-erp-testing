// ---------------------------------------------------------------------------
// agent-brain.ts — the ONE shared Claude caller for every agent family.
//
// Iron rule 2 (AGENTS-BLUEPRINT): deterministic engines do the arithmetic,
// the LLM only does judgment / attribution / language. This helper is the
// "brain socket" each agent plugs its already-computed numbers into:
//
//   askAgentBrain(apiKey, { system, payload, usageSink }) → string | null
//
// Contract, shared by all callers:
//   - best-effort: any failure (no key, HTTP error, empty text) returns null
//     and the agent's deterministic output ships unchanged — the brain can
//     NEVER sink a brief or a cron run;
//   - token usage is reported into `usageSink` so recordAgentRun surfaces
//     real spend on the Agent Console (老板问 "它的 usage 是多少" 的口径);
//   - payload is JSON.stringify'd verbatim — callers pre-compact their data
//     (send the numbers that matter, not whole tables).
//
// Extracted from production-brief.ts's generateAiFocus (2026-07-12) so the
// Delivery / CS / future agents reuse one tested path instead of each
// hand-rolling the fetch.
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Same model as the in-app assistant — one model, one bill, one behaviour. */
export const AGENT_BRAIN_MODEL = "claude-sonnet-4-5-20250929";

export interface AgentBrainUsageSink {
  tokensIn: number;
  tokensOut: number;
}

export interface AskAgentBrainOptions {
  /** System prompt — the agent's voice + task ("write今日焦点", etc.). */
  system: string;
  /** Pre-compacted JSON-serialisable data the brain reasons over. */
  payload: unknown;
  /** Response cap; briefs are one short paragraph, keep this tight. */
  maxTokens?: number;
  /** Accumulates Anthropic token usage for the Agent Console run log. */
  usageSink?: AgentBrainUsageSink;
}

export async function askAgentBrain(
  apiKey: string | undefined,
  opts: AskAgentBrainOptions,
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_BRAIN_MODEL,
        max_tokens: opts.maxTokens ?? 700,
        system: opts.system,
        messages: [{ role: "user", content: JSON.stringify(opts.payload) }],
      }),
    });
    if (!res.ok) {
      console.warn(`[agent-brain] Anthropic ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (opts.usageSink && j.usage) {
      opts.usageSink.tokensIn += Number(j.usage.input_tokens) || 0;
      opts.usageSink.tokensOut += Number(j.usage.output_tokens) || 0;
    }
    const text = (j.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.warn("[agent-brain] failed:", err);
    return null;
  }
}
