// ---------------------------------------------------------------------------
// Hookka AI — chat UI.
//
// Talks to POST /api/assistant/chat which returns SSE. Each event is a
// JSON-encoded object:
//   { type: "text", value: "..." }            → append to current assistant msg
//   { type: "tool_call_start", name: "..." }  → push a tool-chip into the msg
//   { type: "tool_call_end", name: "..." }    → mark chip as completed
//   { type: "error", message: "..." }         → error banner
//   { type: "done" }                          → close the stream
//
// In-session memory only — refreshing the tab clears history. That's by
// design for v1 (no persistence to keep the schema footprint small).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { HookkaAILogo } from "@/components/assistant/HookkaAILogo";

type ChatRole = "user" | "assistant";

type ToolChip = {
  name: string;
  state: "running" | "done";
};

type MessageBlock = { type: "text"; text: string } | { type: "tool"; tool: ToolChip };

type ChatMessage = {
  id: string;
  role: ChatRole;
  // For user messages: a single text block. For assistant: a sequence of
  // text + tool chips in the order they streamed in.
  blocks: MessageBlock[];
};

function uid(): string {
  return `msg-${Math.random().toString(36).slice(2, 10)}`;
}

// Very basic markdown rendering — bold (**...**), inline code (`...`),
// fenced code blocks (```...```), bullet lists (- ), and pipe-separated
// table rows. Avoids pulling in react-markdown (~80KB) for v1. The AI is
// instructed to reply in this format.
function renderMarkdown(text: string): React.ReactNode {
  // Split fenced code first so the inline pass doesn't touch its contents.
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3).replace(/^[a-zA-Z]+\n/, "");
      return (
        <pre
          key={idx}
          className="my-2 rounded bg-[#1F1D1B] text-[#F0ECE9] p-3 text-xs overflow-x-auto whitespace-pre"
        >
          <code>{inner}</code>
        </pre>
      );
    }
    return <InlineMarkdown key={idx} text={part} />;
  });
}

function InlineMarkdown({ text }: { text: string }) {
  // Detect a markdown table block (consecutive lines that start with `|`).
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Table — line starts with `|` and the next line is a separator.
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*[:\-| ]+$/.test(lines[i + 1])
    ) {
      const tableLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|")
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      nodes.push(<TableBlock key={`t-${i}`} lines={tableLines} />);
      continue;
    }
    // Bullet list — collect consecutive `- ` lines.
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={`u-${i}`} className="my-2 ml-5 list-disc space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.length > 0) {
      nodes.push(
        <span key={`l-${i}`}>
          {renderInline(line)}
        </span>,
      );
    }
    // Preserve blank lines as paragraph breaks.
    if (i + 1 < lines.length) {
      nodes.push(<br key={`br-${i}`} />);
    }
    i++;
  }
  return <>{nodes}</>;
}

function TableBlock({ lines }: { lines: string[] }) {
  // First line is header, second is separator (skipped), rest are rows.
  const cells = (line: string): string[] =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((s) => s.trim());
  const header = lines[0] ? cells(lines[0]) : [];
  const rows = lines.slice(2).map(cells);
  return (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-[#E2DDD8]">
            {header.map((h, idx) => (
              <th key={idx} className="px-2 py-1 text-left font-semibold">
                {renderInline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-[#F0ECE9]">
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-1 align-top">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Inline formatting: bold + inline code. Keep it small — anything fancier
// would need a real parser.
function renderInline(text: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  // Pattern matches **bold** OR `code` — capturing the delimiter style so
  // we know which to render. Anything not matched is plain text.
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) {
      tokens.push(text.slice(lastIdx, m.index));
    }
    if (m[2] !== undefined) {
      tokens.push(
        <strong key={`b-${key++}`} className="font-semibold">
          {m[2]}
        </strong>,
      );
    } else if (m[3] !== undefined) {
      tokens.push(
        <code
          key={`c-${key++}`}
          className="rounded bg-[#F0ECE9] px-1 py-[1px] text-[0.85em] font-mono"
        >
          {m[3]}
        </code>,
      );
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    tokens.push(text.slice(lastIdx));
  }
  return <>{tokens}</>;
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on new message / streamed text.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;

    setError(null);
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      blocks: [{ type: "text", text: trimmed }],
    };
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: "assistant",
      blocks: [],
    };
    // Build the payload from history + new turn. The route expects plain
    // text-only messages — we strip tool chips since the model doesn't
    // see them (they're a UI affordance only; the model's own tool_use
    // blocks are re-built server-side from the message history of each
    // call, not from the browser state).
    const payloadMessages = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.blocks
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim(),
    })).filter((m) => m.content.length > 0);

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setDraft("");
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadMessages }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // Non-streaming error path — body is JSON.
        let errText = `Request failed (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) errText = j.error;
        } catch {
          // ignore
        }
        setError(errText);
        setBusy(false);
        return;
      }
      if (!res.body) {
        setError("No response body");
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines.
        let sepIdx: number;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + 2);
          const dataLine = chunk
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const jsonStr = dataLine.slice("data:".length).trim();
          if (!jsonStr) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (evt.type === "text" && typeof evt.value === "string") {
            const delta = evt.value;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const blocks = [...last.blocks];
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "text") {
                blocks[blocks.length - 1] = {
                  type: "text",
                  text: lastBlock.text + delta,
                };
              } else {
                blocks.push({ type: "text", text: delta });
              }
              next[next.length - 1] = { ...last, blocks };
              return next;
            });
          } else if (evt.type === "tool_call_start" && typeof evt.name === "string") {
            const toolName = evt.name;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const blocks = [...last.blocks, {
                type: "tool" as const,
                tool: { name: toolName, state: "running" as const },
              }];
              next[next.length - 1] = { ...last, blocks };
              return next;
            });
          } else if (evt.type === "tool_call_end" && typeof evt.name === "string") {
            const toolName = evt.name;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const blocks = last.blocks.map((b) => {
                if (
                  b.type === "tool" &&
                  b.tool.name === toolName &&
                  b.tool.state === "running"
                ) {
                  return {
                    type: "tool" as const,
                    tool: { name: toolName, state: "done" as const },
                  };
                }
                return b;
              });
              next[next.length - 1] = { ...last, blocks };
              return next;
            });
          } else if (evt.type === "error" && typeof evt.message === "string") {
            setError(evt.message);
          }
          // done → loop exits when reader returns done; nothing to do here.
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [draft, busy, messages]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-180px)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4 border-b border-[#E2DDD8]">
        <div className="h-10 w-10 rounded-full bg-[#1F1D1B] text-white flex items-center justify-center">
          <HookkaAILogo size={22} />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-[#1F1D1B]">Hookka AI</h1>
          <p className="text-xs text-[#6B7280]">
            Read-only assistant for orders, deliveries, invoices, and customers.
          </p>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto py-4 space-y-4"
      >
        {messages.length === 0 && (
          <div className="text-center text-[#6B7280] mt-12 text-sm">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-[#F0ECE9] text-[#1F1D1B] flex items-center justify-center">
              <HookkaAILogo size={26} />
            </div>
            <p className="font-medium text-[#1F1D1B]">Ask me anything about today.</p>
            <p className="mt-1">
              Try: "What sales orders are due this week?" or "Show me unpaid invoices for Cosmos."
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-[#6B7280] pl-12">
            <span className="inline-block h-2 w-2 rounded-full bg-[#6B5C32] animate-pulse" />
            Hookka AI is typing...
          </div>
        )}
        {error && (
          <div className="mx-auto max-w-md rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-[#E2DDD8] pt-3">
        <div className="flex gap-2 items-end">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask Hookka AI..."
            rows={2}
            className="flex-1 resize-none rounded-md border border-[#E2DDD8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
            disabled={busy}
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="h-10 px-4 rounded-md bg-[#E2DDD8] text-[#1F1D1B] text-sm font-medium hover:bg-[#d4cfca]"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={!draft.trim()}
              className="h-10 px-4 rounded-md bg-[#1F1D1B] text-white text-sm font-medium hover:bg-[#3a3633] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-[#6B7280]">
          Read-only. Chat history clears when you leave this page.
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="h-8 w-8 mt-1 mr-2 rounded-full bg-[#1F1D1B] text-white flex items-center justify-center shrink-0">
          <HookkaAILogo size={18} />
        </div>
      )}
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
          isUser
            ? "bg-[#1F1D1B] text-white"
            : "bg-[#F0ECE9] text-[#1F1D1B]"
        }`}
      >
        {message.blocks.length === 0 && !isUser && (
          <span className="text-[#6B7280] italic text-xs">Thinking...</span>
        )}
        {message.blocks.map((b, idx) => {
          if (b.type === "tool") {
            return (
              <span
                key={idx}
                className={`inline-flex items-center gap-1 my-1 mr-1 rounded-full border px-2 py-[1px] text-[11px] ${
                  b.tool.state === "running"
                    ? "border-[#6B5C32] text-[#6B5C32] bg-white/60"
                    : "border-[#A3D9A5] text-[#3C763D] bg-white/60"
                }`}
              >
                {b.tool.state === "running" ? "Looking up" : "Used"}{" "}
                {prettyToolName(b.tool.name)}
              </span>
            );
          }
          return (
            <div key={idx} className="whitespace-pre-wrap break-words">
              {isUser ? b.text : renderMarkdown(b.text)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function prettyToolName(name: string): string {
  // list_sales_orders → "sales orders"
  return name.replace(/^(list|get)_/, "").replace(/_/g, " ");
}
