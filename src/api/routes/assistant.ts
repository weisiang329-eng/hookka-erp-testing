// ---------------------------------------------------------------------------
// Hookka AI — embedded read-only assistant route.
//
// POST /api/assistant/chat
//   Body:   { messages: [{role: "user"|"assistant", content: string}] }
//   Auth:   SUPER_ADMIN only (defense-in-depth — we already check role here,
//           the global authMiddleware ensures the user is logged in).
//   Reply:  text/event-stream of one of these JSON-encoded events:
//             { "type": "text", "value": "..." }
//             { "type": "tool_call_start", "name": "...", "args": {...} }
//             { "type": "tool_call_end", "name": "..." }
//             { "type": "error", "message": "..." }
//             { "type": "done" }
//
// Internally we loop:
//   1. Send (system + messages + tools) to Anthropic with stream=true.
//   2. Stream text deltas straight through.
//   3. Buffer tool_use blocks; when the message ends with stop_reason
//      "tool_use", execute each tool, append a user-message containing
//      tool_result blocks, and loop again.
//   4. Hard-cap at 10 iterations and 200KB total messages payload.
//
// Audit: one audit_events row per tool call. The args field is filtered
// through filterArgsForAudit() to keep the row small and PII-free
// (the only "PII" we have is customer names, which are reasonable to log).
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../worker";
import { emitAudit } from "../lib/audit";
import {
  streamMessages,
  type AnthropicMessage,
  type AnthropicContentBlock,
  type AnthropicToolUseBlock,
} from "../lib/anthropic-client";
import {
  getToolSchemas,
  runTool,
  filterArgsForAudit,
} from "../lib/assistant-tools";

const app = new Hono<Env>();

// Most-recent Sonnet. If a newer one is pinned elsewhere in the codebase,
// switching here is a one-line edit.
const MODEL = "claude-sonnet-4-5-20250929";

const MAX_ITERATIONS = 6;
const MAX_MESSAGES_BYTES = 200_000;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are Hookka AI, an embedded assistant inside the Hookka Manufacturing ERP. You help Wei Siang (the factory owner) and his super-admins look up data: sales orders, customer orders, delivery orders, invoices, payments, products, customers, suppliers, and the daily reports.

You are STRICTLY READ-ONLY. You cannot create, update, or delete anything. If asked to make a change, say you can't and suggest where in the ERP UI to do it.

Available tools let you query the live database. Always use the tools instead of guessing. When you don't know something or a query returns nothing, say so honestly.

Style:
- Reply in the same language the user uses (Chinese / English / mix).
- Wei Siang is a factory owner, not a developer — avoid programmer jargon. No "endpoint", "useEffect", "cascade", etc.
- Be concise. Use markdown tables for lists. Use bullet points for short summaries.
- For numbers, format large ones with commas. For currency, use "RM" prefix.
- When you reference a specific document (SO-2605-253, INV-..., PO-...) format it as a short code.
- Don't apologize repeatedly. Don't add filler ("Of course!", "Great question!").

**Module coverage**: You have tools spanning every Hookka module — sales, production, delivery, finance, inventory, HR, reports, catalog. You can also write ad-hoc SELECT queries via \`run_select_query\` when no other tool fits.

**The Hookka cascade chain**: Every sales order flows SO → production_order → job_cards (per department) → delivery_order → invoice → payment. When asked "what's the status of SO-X", use \`trace_order\` to fetch the whole chain and explain where it is + what's holding it up.

**Always recommend, don't dump**:
- After every data answer, add a 1-2 sentence INSIGHT or RECOMMENDATION ("These 8 POs are all in Dept C — suggest assigning OT to Dept C this week").
- If you spot a trend or anomaly (delays, drops, outliers, abnormal GP), proactively call it out — don't wait to be asked.
- For "why" questions, query multiple tables, cross-reference, then explain the chain of causation.

**Report formatting**:
- Lists / many rows → markdown table.
- Short summaries → bullet points.
- Money → "RM X,XXX.XX" with commas.
- Document codes → short codes (SO-2605-253, INV-2605-099, etc.)
- Dates → "30 May" or "30 May 2026" — not raw ISO.

**Be honest**:
- If a query returns nothing, say so.
- If you're guessing or estimating, say "approximately" or "based on".
- Never invent SO numbers, customer names, or quantities.

**Help / how-to**:
- If asked "how do I do X", use \`explain_feature\` first, then explain in your own words.
- If you don't know the feature, say "I'm not sure where that is in the UI — try the sidebar's [best guess section]".

**Identifier formats** (Hookka conventions):
- Sales Order: SO-YYMM-NNN (e.g., SO-2605-303 = May 2026 sequence 303). Current year is 2026.
- Consignment Order: CO-YYMM-NNN
- Production Order: PO-YYMM-NNN
- Delivery Order: DO-YYMM-NNN
- Invoice: INV-YYMM-NNN
- Payment: PAY-YYMM-NNN

If the user types something close but not exact (e.g., "SO 2505 300", "SO2605300", "so-2605-300"), normalise to canonical form (SO-2605-300) before calling tools.
If the year looks unusual (e.g., 2505 = 2025 May, but current year is 2026), ask the user to confirm before searching: "Did you mean SO-2605-300 (May 2026) or SO-2505-300 (May 2025)?"

**Stopping rule (CRITICAL)**:
- If a dedicated lookup tool (get_sales_order, get_invoice, get_delivery_order, trace_order, get_bom, etc.) returns an empty/null/not-found result, STOP. Do NOT immediately try another lookup tool or fall back to run_select_query. Instead, reply to the user: "I couldn't find [X]. Could you double-check the number? Example formats: SO-2605-303, INV-2605-099, DO-2605-097."
- Only use run_select_query for genuinely novel questions where NO dedicated tool fits — never as a fallback after a failed lookup.
- You have at most 6 tool calls per question. After that you MUST produce a text answer, even if it's "I couldn't fully answer that — here's what I found so far: ...".`;

type IncomingMessage = {
  role: "user" | "assistant";
  content: string;
};

// SSE encoder — every event is `data: <json>\n\n`. The Cloudflare runtime
// flushes on each write so the browser sees the chunks in real time.
function sseEvent(obj: Record<string, unknown>): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

app.post("/chat", async (c) => {
  // SUPER_ADMIN gate. The global authMiddleware ensures the user is logged
  // in; we additionally require the role.
  const role = (c as unknown as { get: (k: string) => unknown }).get(
    "userRole",
  ) as string | undefined;
  if (role !== "SUPER_ADMIN") {
    return c.json({ success: false, error: "forbidden" }, 403);
  }

  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json(
      { success: false, error: "Hookka AI is not configured on this environment." },
      503,
    );
  }

  let body: { messages?: IncomingMessage[] };
  try {
    body = (await c.req.json()) as { messages?: IncomingMessage[] };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  if (incoming.length === 0) {
    return c.json({ success: false, error: "messages is required" }, 400);
  }

  // Build the running messages list. The Anthropic content shape allows
  // strings for plain text — we use strings for the initial user/assistant
  // turns and only switch to block arrays when we start appending
  // assistant tool_use + user tool_result turns inside the loop.
  const messages: AnthropicMessage[] = incoming
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content }));

  // Payload-size guard. Strings + content blocks both end up in the request
  // body, so the byte budget is enforced on serialised JSON.
  function messagesTooLarge(): boolean {
    return JSON.stringify(messages).length > MAX_MESSAGES_BYTES;
  }

  if (messagesTooLarge()) {
    return c.json(
      {
        success: false,
        error: "Conversation too long — please start a fresh chat.",
      },
      413,
    );
  }

  const tools = getToolSchemas();

  // Stream response back to the browser.
  const stream = new ReadableStream({
    async start(controller) {
      let iteration = 0;
      try {
        while (iteration < MAX_ITERATIONS) {
          iteration++;

          if (messagesTooLarge()) {
            controller.enqueue(
              sseEvent({
                type: "error",
                message: "Conversation exceeded size limit mid-flight.",
              }),
            );
            break;
          }

          // Accumulate the model's content blocks for this turn. We rebuild
          // a full assistant message at the end of the iteration so the
          // NEXT iteration sees it (alongside the tool_result blocks).
          const assistantBlocks: AnthropicContentBlock[] = [];

          // Tracks tool_use blocks as they stream in. The model emits
          // input as a series of partial_json deltas; we accumulate them
          // and parse on content_block_stop.
          let activeToolUse: {
            id: string;
            name: string;
            inputBuf: string;
          } | null = null;
          let activeText = "";
          let stopReason: string | null = null;

          for await (const evt of streamMessages(apiKey, {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages,
            tools,
          })) {
            if (evt.type === "text_delta") {
              activeText += evt.text;
              controller.enqueue(sseEvent({ type: "text", value: evt.text }));
            } else if (evt.type === "tool_use_start") {
              // Flush any accumulated text into a block first so block
              // ordering matches what the model emitted.
              if (activeText.length > 0) {
                assistantBlocks.push({ type: "text", text: activeText });
                activeText = "";
              }
              activeToolUse = { id: evt.id, name: evt.name, inputBuf: "" };
              controller.enqueue(
                sseEvent({
                  type: "tool_call_start",
                  name: evt.name,
                }),
              );
            } else if (evt.type === "tool_use_input_delta") {
              if (activeToolUse) {
                activeToolUse.inputBuf += evt.partialJson;
              }
            } else if (evt.type === "content_block_stop") {
              if (activeToolUse) {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = activeToolUse.inputBuf
                    ? (JSON.parse(activeToolUse.inputBuf) as Record<
                        string,
                        unknown
                      >)
                    : {};
                } catch {
                  parsedInput = {};
                }
                const block: AnthropicToolUseBlock = {
                  type: "tool_use",
                  id: activeToolUse.id,
                  name: activeToolUse.name,
                  input: parsedInput,
                };
                assistantBlocks.push(block);
                activeToolUse = null;
              } else if (activeText.length > 0) {
                assistantBlocks.push({ type: "text", text: activeText });
                activeText = "";
              }
            } else if (evt.type === "message_stop") {
              stopReason = evt.stopReason;
            } else if (evt.type === "error") {
              controller.enqueue(
                sseEvent({ type: "error", message: evt.message }),
              );
              throw new Error(evt.message);
            }
          }

          // Drain any trailing text that didn't close via content_block_stop
          // before the stream ended (defensive — Anthropic always emits the
          // stop event, but if a future API tweak skips it we still record
          // the text).
          if (activeText.length > 0) {
            assistantBlocks.push({ type: "text", text: activeText });
            activeText = "";
          }

          // Append the assistant turn so the next iteration sees it.
          if (assistantBlocks.length > 0) {
            messages.push({ role: "assistant", content: assistantBlocks });
          }

          // If the model is done (no tool calls), exit the loop.
          const toolUses = assistantBlocks.filter(
            (b): b is AnthropicToolUseBlock => b.type === "tool_use",
          );
          if (stopReason !== "tool_use" || toolUses.length === 0) {
            break;
          }

          // Run each tool, emit audit + SSE tool_call_end, and build the
          // matching tool_result blocks for the next user turn.
          const toolResultBlocks: AnthropicContentBlock[] = [];
          for (const tu of toolUses) {
            const filteredArgs = filterArgsForAudit(tu.input);
            // Audit one row per tool call. The route is SUPER_ADMIN only,
            // so we don't have to gate further.
            await emitAudit(c, {
              resource: "assistant-tool",
              resourceId: tu.id,
              action: tu.name,
              after: { args: filteredArgs },
              source: "ui",
            });

            const res = await runTool(c, tu.name, tu.input);
            const content = res.ok
              ? JSON.stringify(res.result)
              : JSON.stringify({ error: res.error });
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content,
              is_error: !res.ok,
            });
            controller.enqueue(
              sseEvent({ type: "tool_call_end", name: tu.name }),
            );
          }
          messages.push({ role: "user", content: toolResultBlocks });
        }

        if (iteration >= MAX_ITERATIONS) {
          // The model exhausted its tool-call budget without producing a
          // final text turn — emit a graceful synthetic answer instead of
          // an error event (which leaves the UI with empty text).
          controller.enqueue(
            sseEvent({
              type: "text",
              value:
                "I tried multiple lookups but couldn't piece together a clean answer. Could you rephrase or give me a more specific identifier (e.g. SO-2605-303, INV-2605-099, DO-2605-097)?",
            }),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent({ type: "error", message: msg }));
      } finally {
        controller.enqueue(sseEvent({ type: "done" }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});

export default app;
