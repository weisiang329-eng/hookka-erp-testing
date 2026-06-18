// ---------------------------------------------------------------------------
// Mail Center — thread detail (P2: reply + resolve/reopen; P3: assign).
//
// Renders a conversation's messages. Bodies are shown as PLAIN TEXT
// (textBody, or HTML stripped to text) — we never inject untrusted customer
// HTML into the DOM. P2 adds an in-ERP reply composer (POST .../reply, sent
// via Brevo from the thread's mailbox) and a resolve/reopen control
// (PATCH .../:id status). Both refresh the thread via cache invalidation.
//
// DUAL-MODE (P3 UI overhaul): this same component powers BOTH
//   • the standalone /mail-center/:id route  (id from useParams), and
//   • the desktop reading pane embedded inside index.tsx (id passed as a
//     prop, embedded=true to drop the page wrapper + the "Back to inbox"
//     button that only makes sense on the full-page route).
// Pass an optional `id` prop; it falls back to useParams when absent, so the
// standalone route keeps working unchanged.
// ---------------------------------------------------------------------------
import { useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { csrfHeaders } from "@/lib/csrf";
import { cn } from "@/lib/utils";
import {
  patchThreadStarred,
  patchThreadLabels,
  patchThreadUnread,
  patchThreadTrashed,
} from "./mail-actions";
import {
  type MailLabel,
  LABEL_PALETTE,
  labelColorMap,
  colorForLabel,
  chipStyle,
} from "./mail-labels";
import { createLabel } from "./mail-actions";
import { ComposeDialog } from "./compose";
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  Reply,
  Forward,
  Archive,
  Inbox,
  Loader2,
  UserPlus,
  Check,
  Star,
  Trash2,
  MailWarning,
  Tag,
  X,
  Plus,
  Paperclip,
} from "lucide-react";

type UserOption = {
  id: string;
  email: string;
  displayName: string;
};

type UsersEnvelope = { success?: boolean; data?: UserOption[] };

// One attachment served on a message. `url` is a short-lived SIGNED Supabase
// Storage URL (or null when signing failed server-side); sizeBytes is the byte
// count for the "(size)" hint. Inline cid: images inside the HTML body are a v2
// concern — here every attachment is listed as a downloadable chip (image types
// additionally get a thumbnail preview).
type MailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId?: string;
  url: string | null;
};

type MailMessage = {
  id: string;
  direction: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  sentAt: string;
  receivedAt: string;
  createdAt: string;
  attachments?: MailAttachment[];
};

type MailThread = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
  assignedToUserId?: string;
  assignedToName?: string;
  // DB-backed email-client fields (server-side; arrive on the thread).
  starred: boolean;
  labels: string[];
  trashedAt: string | null;
};

type ThreadDetail = {
  thread: MailThread;
  messages: MailMessage[];
};

function fmtFull(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

// Human-readable byte size for the attachment chip hint, e.g. "12 KB", "3.4 MB".
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// Whether an attachment is an image we can preview as a thumbnail.
function isImageAttachment(a: MailAttachment): boolean {
  return /^image\//i.test(a.contentType || "");
}

// Strip HTML to readable text as a fallback when a message has no plain-text
// part. Never rendered as HTML — output is escaped by React as a text node.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type MailCenterDetailProps = {
  // When embedded in the desktop reading pane, the parent passes the route id
  // as a prop. On the standalone /mail-center/:id route this is omitted and we
  // fall back to useParams. `embedded` drops the page-level max-width wrapper
  // and the "Back to inbox" button (both only make sense full-page).
  id?: string;
  embedded?: boolean;
};

export default function MailCenterDetailPage({
  id: idProp,
  embedded = false,
}: MailCenterDetailProps = {}) {
  const params = useParams<{ id: string }>();
  const id = idProp ?? params.id;
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const url = id ? `/api/mail-center/threads/${id}` : null;
  const { data, loading, error } = useCachedJson<ThreadDetail>(url, 30);

  // Users for the Assign dropdown. Envelope is { success, data:[] } (see
  // routes/users.ts). Loaded lazily; the select degrades to disabled if empty.
  const { data: usersResp } = useCachedJson<UsersEnvelope>("/api/users", 300);
  const users = usersResp?.data ?? [];
  // Label catalogue (name → colour) for the chip colours + the add-label menu.
  const { data: labelCatalog } = useCachedJson<MailLabel[]>(
    "/api/mail-center/labels",
    60,
  );
  const colorMap = labelColorMap(labelCatalog ?? []);

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  // Forward dialog (opens ComposeDialog prefilled). Reply scrolls to + focuses
  // the always-visible reply composer at the bottom of the conversation.
  const [forwardOpen, setForwardOpen] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Star / labels / trashed are DB-backed and arrive on the thread itself.
  const starred = thread?.starred ?? false;
  const trashed = thread?.trashedAt != null;
  const chips = thread?.labels ?? [];

  // Star / unstar via PATCH starred, then refresh this thread + the list.
  async function handleToggleStar() {
    if (!id || mutating) return;
    setMutating(true);
    try {
      const ok = await patchThreadStarred(id, !starred);
      if (!ok) toast.error("Couldn’t update. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  // Move to / restore from Trash via PATCH trashed. Trashing also navigates
  // back on the full-page route since the thread leaves every normal folder.
  async function handleTrash() {
    if (!id || mutating) return;
    if (trashed) {
      setMutating(true);
      try {
        const ok = await patchThreadTrashed(id, false);
        toast[ok ? "info" : "error"](
          ok ? "Restored from Trash." : "Couldn’t restore. Please try again.",
        );
      } finally {
        setMutating(false);
      }
      return;
    }
    const confirmed = await confirm({
      title: "Move to Trash?",
      message:
        "This conversation moves to the Trash folder. You can restore it from there.",
      confirmLabel: "Move to Trash",
      tone: "danger",
    });
    if (!confirmed) return;
    setMutating(true);
    try {
      const ok = await patchThreadTrashed(id, true);
      if (ok) {
        toast.info("Moved to Trash.");
        if (!embedded) navigate("/mail-center");
      } else {
        toast.error("Couldn’t move to Trash. Please try again.");
      }
    } finally {
      setMutating(false);
    }
  }

  async function handleMarkUnread() {
    if (!id || mutating) return;
    setMutating(true);
    try {
      const ok = await patchThreadUnread(id, true);
      toast[ok ? "success" : "error"](
        ok ? "Marked as unread." : "Couldn’t update. Please try again.",
      );
    } finally {
      setMutating(false);
    }
  }

  async function handleAddLabel() {
    if (!id || mutating) return;
    const clean = newLabel.trim();
    if (!clean) return;
    // Replace the whole label set (PATCH labels). De-dupe case-insensitively.
    if (chips.some((l) => l.toLowerCase() === clean.toLowerCase())) {
      setNewLabel("");
      return;
    }
    setMutating(true);
    try {
      // Ensure the catalogue carries this name so it gets a colour + shows in
      // the sidebar (idempotent server-side; a known name is a no-op).
      if (!colorMap.has(clean.toLowerCase())) {
        await createLabel(clean, LABEL_PALETTE[0].value);
      }
      const ok = await patchThreadLabels(id, [...chips, clean]);
      if (ok) setNewLabel("");
      else toast.error("Couldn’t add label. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  // Reply — scroll the always-visible reply composer into view and focus it.
  function focusReply() {
    const el = replyRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }

  // Remove a label by replacing the set without it (PATCH labels).
  async function handleRemoveLabel(label: string) {
    if (!id || mutating) return;
    const next = chips.filter(
      (l) => l.toLowerCase() !== label.toLowerCase(),
    );
    setMutating(true);
    try {
      const ok = await patchThreadLabels(id, next);
      if (!ok) toast.error("Couldn’t remove label. Please try again.");
    } finally {
      setMutating(false);
    }
  }

  // Send the composed reply, then invalidate this thread's cache so the new
  // outbound message + updated status flag refetch immediately (the hook
  // subscribes to its own URL's invalidations — see lib/cached-fetch.ts).
  async function handleSend() {
    if (!url || sending) return;
    const text = replyText.trim();
    if (!text) return;
    setSending(true);
    try {
      const res = await fetch(`${url}/reply`, {
        method: "POST",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        let msg = "Failed to send reply. Please try again.";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          /* non-JSON error body — keep the default message */
        }
        toast.error(msg);
        return;
      }
      setReplyText("");
      toast.success("Reply sent.");
      invalidateCache(url);
    } catch {
      toast.error("Failed to send reply. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  // Mark done / move to Inbox via PATCH status, then refresh the thread.
  // (UI labels only — the API status values are still "open" / "closed".)
  async function handleSetStatus(status: "open" | "closed") {
    if (!url || updatingStatus) return;
    setUpdatingStatus(true);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        toast.error("Failed to update status. Please try again.");
        return;
      }
      toast.success(status === "closed" ? "Archived." : "Moved to Inbox.");
      invalidateCache(url);
    } catch {
      toast.error("Failed to update status. Check your connection and try again.");
    } finally {
      setUpdatingStatus(false);
    }
  }

  // Assign this thread to a user (or clear assignment) via the EXISTING PATCH
  // endpoint that already handles status — { assignedToUserId, assignedToName }.
  // No backend change. An empty selection clears the assignee (null on both
  // fields). Refreshes the thread so the assignee Badge updates immediately.
  async function handleAssign(userId: string) {
    if (!url || assigning) return;
    const picked = users.find((u) => u.id === userId);
    const assignedToUserId = userId || null;
    const assignedToName = picked
      ? picked.displayName || picked.email
      : null;
    setAssigning(true);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({ assignedToUserId, assignedToName }),
      });
      if (!res.ok) {
        toast.error("Failed to assign. Please try again.");
        return;
      }
      toast.success(
        assignedToName ? `Assigned to ${assignedToName}.` : "Assignment cleared.",
      );
      invalidateCache(url);
    } catch {
      toast.error("Failed to assign. Check your connection and try again.");
    } finally {
      setAssigning(false);
    }
  }

  const isClosed = thread?.status === "closed";

  return (
    <div className={cn("space-y-4", !embedded && "mx-auto max-w-3xl")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* "Back to inbox" only belongs on the full-page route. In the desktop
            reading pane the list is right there, so we hide it (embedded). */}
        {!embedded ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/mail-center")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to inbox
          </Button>
        ) : (
          <span />
        )}
        {/* Gmail-style action toolbar. Reply / Forward drive the compose flow;
            Archive / Star / Unread / Trash are DB-backed via PATCH /threads/:id
            (Archive = status closed, "Move to Inbox" = status open). The reply
            composer lives at the bottom of the conversation; Reply scrolls to +
            focuses it. */}
        {thread && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              className="gap-1.5 bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
              onClick={focusReply}
              title="Reply to this conversation"
            >
              <Reply className="h-4 w-4" />
              Reply
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setForwardOpen(true)}
              title="Forward this conversation as a new email"
            >
              <Forward className="h-4 w-4" />
              Forward
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cn("gap-1.5", starred && "text-amber-700")}
              onClick={handleToggleStar}
              disabled={mutating}
              title={starred ? "Unstar" : "Star"}
            >
              <Star
                className={cn(
                  "h-4 w-4",
                  starred && "fill-amber-400 text-amber-500",
                )}
              />
              {starred ? "Starred" : "Star"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleMarkUnread}
              disabled={mutating}
              title="Mark this conversation as unread"
            >
              <MailWarning className="h-4 w-4" />
              Unread
            </Button>
            {isClosed ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={updatingStatus}
                onClick={() => handleSetStatus("open")}
              >
                {updatingStatus ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Inbox className="h-4 w-4" />
                )}
                Move to Inbox
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={updatingStatus}
                onClick={() => handleSetStatus("closed")}
                title="Archive (mark done)"
              >
                {updatingStatus ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                Archive
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className={cn("gap-1.5", trashed && "text-amber-700")}
              onClick={handleTrash}
              disabled={mutating}
              title={trashed ? "Restore from Trash" : "Move to Trash"}
            >
              <Trash2 className="h-4 w-4" />
              {trashed ? "Restore" : "Trash"}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {!thread && loading && (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {!thread && !loading && !error && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Thread not found.
        </p>
      )}

      {thread && (
        <>
          {/* Subject header */}
          <div className="space-y-2 border-b border-border pb-3">
            <h1 className="text-xl font-semibold leading-snug text-foreground">
              {thread.subject || "(no subject)"}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                with{" "}
                <strong className="text-foreground/90">
                  {thread.counterpartyName ||
                    thread.counterpartyEmail ||
                    "(unknown sender)"}
                </strong>
                {thread.counterpartyName && thread.counterpartyEmail && (
                  <span className="text-muted-foreground/80">
                    {" "}
                    &lt;{thread.counterpartyEmail}&gt;
                  </span>
                )}
              </span>
              {thread.mailboxAddress && (
                <Badge className="text-[10px]">
                  {thread.mailboxAddress}
                </Badge>
              )}
              {thread.status === "closed" && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                  <Check className="h-3 w-3" />
                  Archived
                </span>
              )}
              {starred && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                  <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                  Starred
                </span>
              )}
              {thread.assignedToName && (
                <Badge className="gap-1 text-[10px]">
                  <UserPlus className="h-3 w-3" />
                  {thread.assignedToName}
                </Badge>
              )}
            </div>

            {/* Labels — DB-backed categories (email_threads.labels). Add a label
                or remove an existing one; the inbox sidebar lists + filters
                by these. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Tag className="h-3.5 w-3.5" />
                Labels
              </span>
              {chips.map((l) => {
                const color = colorForLabel(l, colorMap);
                return (
                  <span
                    key={l}
                    style={chipStyle(color)}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-black/5"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    {l}
                    <button
                      type="button"
                      onClick={() => handleRemoveLabel(l)}
                      disabled={mutating}
                      aria-label={`Remove label ${l}`}
                      className="opacity-70 hover:opacity-100 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
              <div className="flex items-center gap-1">
                <Input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddLabel();
                    }
                  }}
                  placeholder="Add label…"
                  className="h-7 w-28 px-2 text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={!newLabel.trim() || mutating}
                  onClick={handleAddLabel}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            </div>

            {/* Assign control — wired to the EXISTING PATCH .../threads/:id
                with { assignedToUserId, assignedToName }. No backend change. */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <UserPlus className="h-3.5 w-3.5" />
                Assign to
              </label>
              <div className="relative">
                <select
                  value={thread.assignedToUserId ?? ""}
                  onChange={(e) => handleAssign(e.target.value)}
                  disabled={assigning || users.length === 0}
                  className="h-8 rounded-md border border-[#E2DDD8] bg-white px-2 pr-7 text-xs text-[#1F1D1B] focus:border-[#6B5C32] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName || u.email}
                    </option>
                  ))}
                </select>
                {assigning && (
                  <Loader2 className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
          </div>

          {/* Messages — laid out as a mail conversation: an avatar with the
              sender's initial, a from/to header line, the timestamp on the
              right, then the message body as a readable text block. */}
          <div className="space-y-3">
            {messages.map((m) => {
              const outbound = m.direction === "outbound";
              // Prefer the HTML part; if the text part itself IS html (common —
              // many senders, e.g. MyInvois, put a full HTML doc in text/plain),
              // render that as html too. Plain text only when neither is html.
              const rawHtml =
                m.htmlBody?.trim() ||
                (looksLikeHtml(m.textBody) ? (m.textBody || "").trim() : "");
              const plain = rawHtml
                ? ""
                : m.textBody?.trim() || htmlToText(m.htmlBody || "");
              const senderName = m.fromName || m.fromAddress;
              const initial = (senderName || "?").trim().charAt(0).toUpperCase();
              return (
                <Card
                  key={m.id}
                  className={cn(outbound && "border-amber-200 bg-amber-50/40")}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      {/* Avatar — outbound (us) uses the brand tone, inbound
                          (customer) a neutral tone. */}
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                          outbound
                            ? "bg-[#6B5C32] text-white"
                            : "bg-muted text-foreground/70",
                        )}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-semibold text-foreground">
                                {senderName}
                              </span>
                              {outbound ? (
                                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                              ) : (
                                <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              &lt;{m.fromAddress}&gt;
                            </p>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {fmtFull(m.sentAt || m.createdAt)}
                          </span>
                        </div>
                        {m.toAddresses.length > 0 && (
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            To: {m.toAddresses.join(", ")}
                          </p>
                        )}
                        {rawHtml ? (
                          <iframe
                            title="Email"
                            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                            srcDoc={emailSrcDoc(rawHtml)}
                            className="mt-2 w-full border-t border-border/60 bg-white"
                            style={{ minHeight: 80 }}
                            onLoad={(e) => {
                              try {
                                const d = e.currentTarget.contentWindow?.document;
                                if (d)
                                  e.currentTarget.style.height = `${Math.min(
                                    d.body.scrollHeight + 24,
                                    4000,
                                  )}px`;
                              } catch {
                                /* cross-origin guard — keep the min height */
                              }
                            }}
                          />
                        ) : (
                          <pre className="mt-2 whitespace-pre-wrap break-words border-t border-border/60 pt-2 font-sans text-sm leading-relaxed text-foreground/90">
                            {plain || "(empty)"}
                          </pre>
                        )}

                        {/* Attachments — one download chip per file (opens the
                            short-lived signed Storage URL in a new tab). Image
                            attachments additionally show a thumbnail. Inline cid:
                            images inside the HTML body are a v2 concern; here
                            every attachment is just listed as downloadable. */}
                        {(m.attachments?.length ?? 0) > 0 && (
                          <div className="mt-3 border-t border-border/60 pt-2">
                            <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                              <Paperclip className="h-3 w-3" />
                              {m.attachments!.length} attachment
                              {m.attachments!.length === 1 ? "" : "s"}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {m.attachments!.map((a) =>
                                isImageAttachment(a) && a.url ? (
                                  <a
                                    key={a.id}
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`${a.filename}${
                                      a.sizeBytes
                                        ? ` (${formatBytes(a.sizeBytes)})`
                                        : ""
                                    }`}
                                    className="group relative block overflow-hidden rounded-md border border-border bg-white"
                                  >
                                    <img
                                      src={a.url}
                                      alt={a.filename}
                                      loading="lazy"
                                      className="h-20 w-20 object-cover transition-opacity group-hover:opacity-90"
                                    />
                                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
                                      {a.filename}
                                    </span>
                                  </a>
                                ) : a.url ? (
                                  <a
                                    key={a.id}
                                    href={a.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:bg-muted"
                                    title={a.filename}
                                  >
                                    <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{a.filename}</span>
                                    {a.sizeBytes > 0 && (
                                      <span className="shrink-0 text-[10px] text-muted-foreground">
                                        ({formatBytes(a.sizeBytes)})
                                      </span>
                                    )}
                                  </a>
                                ) : (
                                  // No signed URL (signing failed) — show the
                                  // file but make clear it can't be opened.
                                  <span
                                    key={a.id}
                                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground"
                                    title={`${a.filename} (unavailable)`}
                                  >
                                    <Paperclip className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{a.filename}</span>
                                    {a.sizeBytes > 0 && (
                                      <span className="shrink-0 text-[10px]">
                                        ({formatBytes(a.sizeBytes)})
                                      </span>
                                    )}
                                  </span>
                                ),
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {messages.length === 0 && !loading && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No messages in this thread yet.
              </p>
            )}
          </div>

          {/* Reply composer — the always-visible mail reply box at the bottom
              of the conversation. */}
          <Card className="border-amber-200/70 shadow-sm">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                <div className="flex items-center gap-1.5">
                  <Send className="h-3.5 w-3.5 text-amber-600" />
                  <p className="text-sm font-semibold text-foreground">
                    Reply
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  To{" "}
                  {thread.counterpartyName ||
                    thread.counterpartyEmail ||
                    "(unknown sender)"}
                  {thread.mailboxAddress ? ` · from ${thread.mailboxAddress}` : ""}
                </span>
              </div>
              <textarea
                ref={replyRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={6}
                placeholder="Type your reply…"
                disabled={sending}
                className="w-full resize-y rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  Sent via Brevo from {thread.mailboxAddress || "Hookka"}.
                </p>
                <Button
                  size="sm"
                  className="gap-1.5 bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
                  disabled={sending || !replyText.trim()}
                  onClick={handleSend}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Send reply
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Forward — reuses the compose flow (POST /compose, sent via Brevo). The
          dialog opens prefilled with the conversation quoted; the operator fills
          in the recipient. To: is intentionally left blank for them to choose. */}
      {thread && (
        <ComposeDialog
          open={forwardOpen}
          onClose={() => setForwardOpen(false)}
          initialDraft={{
            id: `fwd-${thread.id}`,
            to: "",
            subject: forwardSubject(thread.subject),
            body: forwardBody(thread, messages),
            fromAddress: thread.mailboxAddress || "",
            // Not persisted to the drafts store (only "Save draft" does that),
            // so updatedAt is unused here — keep it stable to stay render-pure.
            updatedAt: 0,
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
}

// "Fwd: <subject>" without double-prefixing an already-forwarded subject.
function forwardSubject(subject: string): string {
  const s = subject || "(no subject)";
  return /^fwd:/i.test(s) ? s : `Fwd: ${s}`;
}

// An email body is usually HTML (a full document or a fragment). We render it in
// a SANDBOXED iframe (sandbox WITHOUT allow-scripts → no untrusted script can run)
// so it looks like a real email; the old <pre> showed the raw HTML source (owner
// 2026-06-18: "字里面为什么是这样子的"). `<base target=_blank>` + allow-popups lets
// links open in a new tab; allow-same-origin (no scripts) only so we can measure
// height to auto-size the frame.
function looksLikeHtml(s: string | undefined): boolean {
  return /<(?:!doctype|html|body|head|div|table|tr|td|p|br|span|a|img|style|font|center|ul|ol|li|h[1-6])[\s>/]/i.test(
    s || "",
  );
}
function emailSrcDoc(rawHtml: string): string {
  const inject = `<base target="_blank"><meta charset="utf-8"><style>html,body{margin:0;padding:10px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#1f1d1b;word-break:break-word;overflow-x:hidden}img{max-width:100%;height:auto}table{max-width:100%}</style>`;
  if (/<head[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rawHtml}</body></html>`;
}

// Build a quoted forward body from the conversation's messages (most recent
// first), each prefixed with a small header line. Plain text only — never raw
// customer HTML (consistent with how the thread is rendered).
function forwardBody(thread: MailThread, messages: MailMessage[]): string {
  const lines: string[] = ["", "---------- Forwarded message ----------"];
  // Newest first reads best at the top of a forward.
  const ordered = messages
    .slice()
    .sort((a, b) =>
      (b.sentAt || b.createdAt).localeCompare(a.sentAt || a.createdAt),
    );
  for (const m of ordered) {
    const who = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
    const when = fmtFull(m.sentAt || m.createdAt);
    const body = m.textBody?.trim() || htmlToText(m.htmlBody || "");
    lines.push("");
    lines.push(`From: ${who}`);
    if (when) lines.push(`Date: ${when}`);
    if (m.subject) lines.push(`Subject: ${m.subject}`);
    lines.push("");
    lines.push(body || "(empty)");
    lines.push("");
    lines.push("--");
  }
  return lines.join("\n");
}
