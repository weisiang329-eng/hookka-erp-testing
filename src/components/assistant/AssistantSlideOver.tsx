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
import { X, Paperclip, FileText, Image as ImageIcon, FileSpreadsheet } from "lucide-react";
import { HookkaAILogo } from "@/components/assistant/HookkaAILogo";
import { humanizeError } from "@/lib/humanize-error";

// File upload limits — these match the server-side guard in
// src/api/lib/attachment-parser.ts. Defined locally so the UI can refuse
// oversized files without a round trip.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const ACCEPTED_TYPES = [
  "image/*",
  "application/pdf",
  "text/csv",
  ".csv",
  ".xlsx",
  ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
].join(",");

type PendingAttachment = {
  // Local id so React can key the chip list when files are removed.
  localId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  // Base64 (no data: prefix). Lazy — computed once when the file is picked.
  base64: string;
  // For images, an object URL for the thumbnail.
  previewUrl?: string;
};

type ChatRole = "user" | "assistant";

type ToolChip = {
  name: string;
  state: "running" | "done";
};

type AttachmentChip = {
  name: string;
  mediaType: string;
  sizeBytes: number;
  previewUrl?: string;
};

type DownloadCard = {
  downloadUrl: string;
  filename: string;
  byteSize: number;
  rowCount: number;
  contentType: string;
  expiresInSeconds: number;
};

type MessageBlock =
  | { type: "text"; text: string }
  | { type: "tool"; tool: ToolChip }
  | { type: "attachment"; attachment: AttachmentChip }
  | { type: "download"; download: DownloadCard };

type ChatMessage = {
  id: string;
  role: ChatRole;
  blocks: MessageBlock[];
};

function uid(): string {
  return `msg-${Math.random().toString(36).slice(2, 10)}`;
}

// Read a File to a base64-encoded string (no data: prefix). Uses FileReader
// for browser compatibility — works in every evergreen browser without
// pulling in a polyfill.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("file read returned non-string"));
        return;
      }
      // result is "data:<mime>;base64,<payload>". Strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function attachmentIconFor(mediaType: string): React.ReactNode {
  if (mediaType.startsWith("image/")) {
    return <ImageIcon className="h-3 w-3" />;
  }
  if (mediaType === "application/pdf") {
    return <FileText className="h-3 w-3" />;
  }
  return <FileSpreadsheet className="h-3 w-3" />;
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

function fileTypeLabel(filename: string, contentType: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || contentType.includes("sheet")) return "Excel";
  if (lower.endsWith(".csv") || contentType.includes("csv")) return "CSV";
  if (lower.endsWith(".pdf") || contentType.includes("pdf")) return "PDF";
  return "File";
}

function fileIcon(label: string): string {
  // ASCII glyphs only — keeps the chat bubble lightweight and prints fine in
  // every browser without pulling in a icon font.
  if (label === "Excel") return "XLS";
  if (label === "CSV") return "CSV";
  if (label === "PDF") return "PDF";
  return "FILE";
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadCardView({ card }: { card: DownloadCard }) {
  const label = fileTypeLabel(card.filename, card.contentType);
  const icon = fileIcon(label);
  const rowText =
    card.rowCount > 0 ? `${card.rowCount.toLocaleString("en-US")} rows` : "";
  const sizeText = formatBytes(card.byteSize);
  const ttlMin = Math.max(1, Math.round(card.expiresInSeconds / 60));
  return (
    <a
      href={card.downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      download={card.filename}
      className="my-2 block rounded-lg border border-[#E2DDD8] bg-white px-3 py-2 hover:border-[#6B5C32] hover:bg-[#FAF8F4] transition-colors no-underline"
    >
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded bg-[#1F1D1B] text-white text-[10px] font-bold flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#1F1D1B] truncate">
            {card.filename}
          </div>
          <div className="text-[11px] text-[#6B7280]">
            {[label, rowText, sizeText].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="text-[11px] text-[#6B5C32] font-medium shrink-0">
          Download
        </div>
      </div>
      <div className="mt-1 text-[10px] text-[#9CA3AF]">
        Link expires in ~{ttlMin} min
      </div>
    </a>
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
          if (b.type === "attachment") {
            const sizeKb = Math.max(1, Math.round(b.attachment.sizeBytes / 1024));
            return (
              <div
                key={idx}
                className="inline-flex items-center gap-2 my-1 mr-1 rounded-md border border-white/30 bg-white/15 px-2 py-1 text-[11px]"
              >
                {b.attachment.previewUrl ? (
                  <img
                    src={b.attachment.previewUrl}
                    alt=""
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-white/20">
                    {attachmentIconFor(b.attachment.mediaType)}
                  </span>
                )}
                <span className="max-w-[140px] truncate" title={b.attachment.name}>
                  {b.attachment.name}
                </span>
                <span className="opacity-70">{sizeKb} KB</span>
              </div>
            );
          }
          if (b.type === "download") {
            return <DownloadCardView key={idx} card={b.download} />;
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Whether the message list is "stuck to bottom". While the user has
  // scrolled up to re-read something, we must NOT yank them back down on
  // every streamed token — only auto-scroll when they're already at the end.
  const stickBottomRef = useRef(true);

  // Desktop panel width — drag the left edge to widen (persisted). Mobile
  // stays full-width (the inline width is only applied at >= sm).
  const MIN_W = 360;
  const MAX_W = 900;
  const [isDesktop, setIsDesktop] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const resizingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const apply = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", apply);
    // Sync viewport + restore saved width once on mount (same on-mount
    // set-state pattern the rest of the app suppresses).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial mount sync
    setIsDesktop(mq.matches);
    try {
      const saved = Number(localStorage.getItem("hookkaai_panel_width"));
      if (Number.isFinite(saved) && saved >= MIN_W) {
        setPanelWidth(Math.min(MAX_W, saved));
      }
    } catch {
      /* localStorage blocked — keep default */
    }
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Left-edge drag to resize. Width = distance from the drag point to the
  // right screen edge (the panel is right-anchored), clamped and persisted.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const w = Math.min(
        Math.min(MAX_W, window.innerWidth - 40),
        Math.max(MIN_W, window.innerWidth - ev.clientX),
      );
      setPanelWidth(w);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setPanelWidth((w) => {
        try {
          localStorage.setItem("hookkaai_panel_width", String(Math.round(w)));
        } catch {
          /* ignore */
        }
        return w;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const onScrollerScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // "Near the bottom" (within 80px) counts as stuck — anything above frees
    // the view so streaming text no longer drags the user down.
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Track which preview URLs are still in use so we can revoke them on
  // unmount. Revocation on individual remove happens in removeAttachment.
  // We keep this in a ref so the cleanup function captures the live set
  // at unmount time instead of a stale snapshot.
  const previewUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const live = new Set<string>();
    for (const a of attachments) {
      if (a.previewUrl) live.add(a.previewUrl);
    }
    previewUrlsRef.current = live;
  }, [attachments]);
  useEffect(() => {
    // Unmount-only — revokes every preview URL still alive when the
    // component is torn down.
    return () => {
      for (const url of previewUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  // Auto-scroll to bottom on new message / streamed text — but ONLY while the
  // user is stuck to the bottom. If they've scrolled up to read, leave them
  // there (fixes: "I can't scroll up while it's typing").
  useEffect(() => {
    if (stickBottomRef.current && scrollerRef.current) {
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
    const hasAttachments = attachments.length > 0;
    // Allow attachment-only messages — the user might just want to drop a
    // photo and let the AI describe what it sees. Send if EITHER text or
    // attachments are present.
    if ((!trimmed && !hasAttachments) || busy) return;

    // Sending a new message always snaps back to the bottom.
    stickBottomRef.current = true;
    setError(null);

    // Capture attachments at send time. We reset state right after so the
    // user can compose a new message while this one is in flight.
    const sendingAttachments = attachments;

    const userBlocks: MessageBlock[] = [];
    for (const a of sendingAttachments) {
      userBlocks.push({
        type: "attachment",
        attachment: {
          name: a.name,
          mediaType: a.mediaType,
          sizeBytes: a.sizeBytes,
          previewUrl: a.previewUrl,
        },
      });
    }
    if (trimmed.length > 0) {
      userBlocks.push({ type: "text", text: trimmed });
    }
    // If the user sent only files, give the model a hint instead of an
    // empty turn — Anthropic requires at least one text or media block.
    if (userBlocks.filter((b) => b.type !== "attachment").length === 0) {
      userBlocks.push({
        type: "text",
        text: "(file attached)",
      });
    }

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      blocks: userBlocks,
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
    setAttachments([]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const body: {
        messages: typeof payloadMessages;
        attachments?: { name: string; mediaType: string; base64: string }[];
      } = { messages: payloadMessages };
      if (sendingAttachments.length > 0) {
        body.attachments = sendingAttachments.map((a) => ({
          name: a.name,
          mediaType: a.mediaType,
          base64: a.base64,
        }));
      }

      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let errText = humanizeError(
          { status: res.status },
          "The assistant couldn't respond. Please try again.",
        );
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error)
            errText = humanizeError({ status: res.status, message: j.error }, errText);
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
          } else if (evt.type === "download" && typeof evt.downloadUrl === "string") {
            const card: DownloadCard = {
              downloadUrl: evt.downloadUrl,
              filename:
                typeof evt.filename === "string" ? evt.filename : "export",
              byteSize:
                typeof evt.byteSize === "number" ? evt.byteSize : 0,
              rowCount:
                typeof evt.rowCount === "number" ? evt.rowCount : 0,
              contentType:
                typeof evt.contentType === "string" ? evt.contentType : "",
              expiresInSeconds:
                typeof evt.expiresInSeconds === "number"
                  ? evt.expiresInSeconds
                  : 3600,
            };
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const blocks = [
                ...last.blocks,
                { type: "download" as const, download: card },
              ];
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
      setError(humanizeError(err, "The assistant couldn't respond. Please try again."));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [draft, busy, messages, attachments]);

  // Handle the <input type="file"> change event. Validates count + size
  // per file and reads each to base64. Failures show inline in the
  // composer error slot — never throws to the parent.
  const onPickFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setError(null);

      const slotsLeft = MAX_ATTACHMENTS_PER_MESSAGE - attachments.length;
      if (slotsLeft <= 0) {
        setError(
          `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        );
        return;
      }

      const incoming = Array.from(files).slice(0, slotsLeft);
      const next: PendingAttachment[] = [];
      for (const f of incoming) {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          setError(`"${f.name}" is over 10 MB — pick a smaller file.`);
          continue;
        }
        try {
          const base64 = await readFileAsBase64(f);
          const previewUrl = f.type.startsWith("image/")
            ? URL.createObjectURL(f)
            : undefined;
          next.push({
            localId: uid(),
            name: f.name,
            mediaType: f.type || "application/octet-stream",
            sizeBytes: f.size,
            base64,
            previewUrl,
          });
        } catch (err) {
          setError(
            `Couldn't read "${f.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (next.length > 0) {
        setAttachments((prev) => [...prev, ...next]);
      }

      // Reset the input so the same file can be re-picked after removing
      // it (browsers ignore change-events for identical FileList).
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [attachments.length],
  );

  // Paste images straight into the composer (Ctrl/Cmd+V) — supports pasting
  // several at once (multiple file items on the clipboard). Falls through to
  // normal text paste when the clipboard has no files.
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault(); // keep the raw image out of the text box
        void onPickFiles(files);
      }
    },
    [onPickFiles],
  );

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => {
      const out = prev.filter((a) => {
        if (a.localId === localId && a.previewUrl) {
          URL.revokeObjectURL(a.previewUrl);
        }
        return a.localId !== localId;
      });
      return out;
    });
  }, []);

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
      className={`fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl border-l border-[#E2DDD8] w-full transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full pointer-events-none"
      }`}
      style={isDesktop ? { width: panelWidth } : undefined}
    >
      {/* Left-edge drag handle — desktop only. Drag to widen the panel. */}
      {isDesktop && (
        <div
          onMouseDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Hookka AI panel"
          title="Drag to resize"
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[#6B5C32]/30 active:bg-[#6B5C32]/50 transition-colors"
        />
      )}

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
      <div
        ref={scrollerRef}
        onScroll={onScrollerScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
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
        {/* Pending attachment chips */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => {
              const sizeKb = Math.max(1, Math.round(a.sizeBytes / 1024));
              return (
                <div
                  key={a.localId}
                  className="inline-flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-[#F8F5F2] px-2 py-1 text-[11px]"
                >
                  {a.previewUrl ? (
                    <img
                      src={a.previewUrl}
                      alt=""
                      className="h-7 w-7 rounded object-cover"
                    />
                  ) : (
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-[#E2DDD8] text-[#6B5C32]">
                      {attachmentIconFor(a.mediaType)}
                    </span>
                  )}
                  <span
                    className="max-w-[120px] truncate text-[#1F1D1B]"
                    title={a.name}
                  >
                    {a.name}
                  </span>
                  <span className="text-[#6B7280]">{sizeKb} KB</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.localId)}
                    aria-label={`Remove ${a.name}`}
                    className="h-4 w-4 rounded-full text-[#6B7280] hover:bg-[#E2DDD8] hover:text-[#1F1D1B] flex items-center justify-center"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            multiple
            className="hidden"
            onChange={(e) => void onPickFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            aria-label="Attach files"
            title={
              attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
                ? `Max ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`
                : "Attach images, PDFs, Excel, or CSV"
            }
            className="h-10 w-10 rounded-md border border-[#E2DDD8] text-[#6B7280] hover:bg-[#F0ECE9] hover:text-[#1F1D1B] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Ask Hookka AI... (paste images with Ctrl/Cmd+V)"
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
              disabled={!draft.trim() && attachments.length === 0}
              className="h-10 px-4 rounded-md bg-[#1F1D1B] text-white text-sm font-medium hover:bg-[#3a3633] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
        <p className="mt-2 text-[10px] text-[#6B7280]">
          Read-only. Chat history clears when you close the panel.
          Attach photos / PDFs / Excel / CSV (max 10 MB, {MAX_ATTACHMENTS_PER_MESSAGE} files).
        </p>
      </div>
    </aside>
  );
}

export default AssistantSlideOver;
