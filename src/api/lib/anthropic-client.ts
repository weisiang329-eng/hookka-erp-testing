// ---------------------------------------------------------------------------
// Thin Anthropic Messages API client — bare fetch, no SDK.
//
// Chosen over @anthropic-ai/sdk because:
//   1. The SDK has Node-flavoured streaming primitives that don't always
//      slot cleanly into the Cloudflare Workers runtime.
//   2. The bundle size hit (~150KB) is wasteful when we only need one
//      endpoint (POST /v1/messages) and SSE parsing.
//
// Powers /api/assistant/chat. See src/api/routes/assistant.ts for the
// tool-calling loop and SSE re-emit to the browser.
// ---------------------------------------------------------------------------

export type AnthropicRole = "user" | "assistant";

export type AnthropicTextBlock = {
  type: "text";
  text: string;
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
};

// One SSE event yielded by streamMessages. We only project the fields the
// route loop actually reads — the raw stream carries a lot of metadata we
// don't need (input_tokens, cache hits, etc.).
export type AnthropicStreamEvent =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "tool_use_start";
      id: string;
      name: string;
    }
  | {
      type: "tool_use_input_delta";
      partialJson: string;
    }
  | {
      type: "content_block_stop";
      index: number;
    }
  | {
      type: "message_stop";
      stopReason: string | null;
    }
  | {
      type: "error";
      message: string;
    };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Stream the Anthropic Messages endpoint. Yields normalised events the
 * route loop can hand straight to the browser (with renaming) or accumulate
 * into a final assistant message.
 *
 * The Anthropic SSE stream is line-delimited: `event: <name>\ndata: <json>\n\n`.
 * We parse JSON lines and project to the AnthropicStreamEvent union above.
 *
 * Throws on HTTP non-2xx — the route catches and turns into an `error`
 * SSE event for the browser.
 */
export async function* streamMessages(
  apiKey: string,
  body: AnthropicRequestBody,
): AsyncGenerator<AnthropicStreamEvent> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Anthropic API ${res.status}: ${errText.slice(0, 400) || res.statusText}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Track the current content block so tool_use blocks can carry their
  // (id, name) forward to subsequent input_json_delta events.
  let currentBlock: { type: string; id?: string; name?: string } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE messages are separated by a blank line (\n\n).
    let sepIdx: number;
    while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sepIdx);
      buf = buf.slice(sepIdx + 2);

      // Each chunk is a few `event: ...` / `data: ...` lines. We only
      // need the data line; the event line carries the same `type` in
      // its body so we can skip it.
      const dataLine = chunk
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice("data:".length).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const t = String(evt.type ?? "");
      if (t === "content_block_start") {
        const cb = evt.content_block as
          | { type: string; id?: string; name?: string }
          | undefined;
        currentBlock = cb ?? null;
        if (cb?.type === "tool_use" && cb.id && cb.name) {
          yield { type: "tool_use_start", id: cb.id, name: cb.name };
        }
      } else if (t === "content_block_delta") {
        const delta = evt.delta as
          | { type: string; text?: string; partial_json?: string }
          | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text_delta", text: delta.text };
        } else if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          yield {
            type: "tool_use_input_delta",
            partialJson: delta.partial_json,
          };
        }
      } else if (t === "content_block_stop") {
        const idx = typeof evt.index === "number" ? evt.index : 0;
        yield { type: "content_block_stop", index: idx };
        currentBlock = null;
      } else if (t === "message_delta") {
        const delta = evt.delta as { stop_reason?: string | null } | undefined;
        if (delta && "stop_reason" in delta) {
          yield {
            type: "message_stop",
            stopReason: delta.stop_reason ?? null,
          };
        }
      } else if (t === "error") {
        const err = evt.error as { message?: string } | undefined;
        yield { type: "error", message: err?.message ?? "unknown error" };
      }
      // message_start / message_stop / ping events ignored.
    }
  }

  // Reference current_block to suppress "declared but never read" linting
  // — the variable is part of the parser state machine even when no
  // downstream event reads it directly.
  void currentBlock;
}
