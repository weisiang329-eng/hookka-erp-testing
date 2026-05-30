// ---------------------------------------------------------------------------
// Hookka AI — slide-over panel.
//
// Standard embedded-assistant UX (Intercom / Drift / ChatGPT widget):
//   - Floating button toggles this panel
//   - Panel fixed to the right edge, full-height
//   - Width ~400px desktop, full-width on mobile (<sm)
//   - Escape + the X button close it
//   - Slides in/out via translate-x; 200ms transition
//
// All chat logic (SSE streaming, tool-call chips, markdown rendering,
// composer + Stop) is inlined here — the dedicated /assistant page was
// removed when this panel shipped. Backend is unchanged: POST
// /api/assistant/chat returns the same SSE event stream.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*[:\-| ]+$/.test(lines[i + 1])
    ) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      nodes.push(<TableBlock key={`t-${i}`} lines={tableLines} />);
      continue;
    }
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
      nodes.push(<span key={`l-${i}`}>{renderInline(line)}</span>);
    }
    if (i + 1 < lines.length) {
      nodes.push(<br key={`br-${i}`} />);
    }
    i++;
  }
  return <>{nodes}</>;
}

function TableBlock({ lines }: { lines: string[] }) {
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

function renderInline(text: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
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

function prettyToolName(name: string): string {
  // list_sales_orders → "sales orders"
  return name.replace(/^(list|get)_/, "").replace(/_/g, " ");
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

export type AssistantSlideOverProps = {
  open: boolean;
  onClose: () => void;
};

export function AssistantSlideOver({ open, onClose }: AssistantSlideOverProps) {
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

  // Escape closes the panel. Only attach the listener while open so we
  // don't fight other esc-handlers on the page (modals, dropdowns) when
  // the panel isn't even up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Abort any in-flight stream when the panel is closed — otherwise the
  // SSE fetch keeps running in the background and bills tokens for a
  // response the user can't see.
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

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
    const payloadMessages = [...messages, userMsg]
      .map((m) => ({
        role: m.role,
        content: m.blocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim(),
      }))
      .filter((m) => m.content.length > 0);

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
              const blocks = [
                ...last.blocks,
                {
                  type: "tool" as const,
                  tool: { name: toolName, state: "running" as const },
                },
              ];
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
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Hookka AI"
      aria-hidden={!open}
      // Slide in/out from the right. `translate-x-full` parks the panel
      // off-screen when closed; `translate-x-0` brings it on. The hidden
      // state also goes pointer-events-none so it doesn't intercept clicks
      // on the page underneath while collapsed.
      className={`fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl border-l border-[#E2DDD8] w-full sm:w-[400px] transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full pointer-events-none"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#E2DDD8] shrink-0">
        <div className="h-9 w-9 rounded-full bg-[#1F1D1B] text-white flex items-center justify-center">
          <HookkaAILogo size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[#1F1D1B]">Hookka AI</h2>
          <p className="text-[11px] text-[#6B7280] truncate">
            Read-only assistant for orders, deliveries, invoices, customers.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Hookka AI"
          className="h-8 w-8 rounded-md flex items-center justify-center text-[#6B7280] hover:bg-[#F0ECE9] hover:text-[#1F1D1B] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Message list */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-[#6B7280] mt-8 text-sm">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-[#F0ECE9] text-[#1F1D1B] flex items-center justify-center">
              <HookkaAILogo size={26} />
            </div>
            <p className="font-medium text-[#1F1D1B]">Ask me anything about today.</p>
            <p className="mt-1 text-xs px-2">
              Try: "What sales orders are due this week?" or "Show me unpaid invoices for Cosmos."
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-[#6B7280] pl-10">
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
      <div className="border-t border-[#E2DDD8] px-3 py-3 shrink-0">
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
          Read-only. Chat history clears when you close the panel.
        </p>
      </div>
    </aside>
  );
}

export default AssistantSlideOver;
