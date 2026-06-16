// ---------------------------------------------------------------------------
// Mail Center — thread detail (P2: reply + resolve/reopen).
//
// Renders a conversation's messages. Bodies are shown as PLAIN TEXT
// (textBody, or HTML stripped to text) — we never inject untrusted customer
// HTML into the DOM. P2 adds an in-ERP reply composer (POST .../reply, sent
// via Brevo from the thread's mailbox) and a resolve/reopen control
// (PATCH .../:id status). Both refresh the thread via cache invalidation.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { csrfHeaders } from "@/lib/csrf";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  CheckCircle2,
  RotateCcw,
  Loader2,
} from "lucide-react";

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
};

type MailThread = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
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

export default function MailCenterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const url = id ? `/api/mail-center/threads/${id}` : null;
  const { data, loading, error } = useCachedJson<ThreadDetail>(url, 30);

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);

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
        let msg = "回复发送失败,请重试。";
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
      toast.success("回复已发送。");
      invalidateCache(url);
    } catch {
      toast.error("回复发送失败,请检查网络后重试。");
    } finally {
      setSending(false);
    }
  }

  // Mark resolved / reopen via PATCH status, then refresh the thread.
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
        toast.error("更新状态失败,请重试。");
        return;
      }
      toast.success(status === "closed" ? "已标记为已处理。" : "已重新打开。");
      invalidateCache(url);
    } catch {
      toast.error("更新状态失败,请检查网络后重试。");
    } finally {
      setUpdatingStatus(false);
    }
  }

  const isClosed = thread?.status === "closed";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/mail-center")}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          返回收件箱
        </Button>
        {thread &&
          (isClosed ? (
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
                <RotateCcw className="h-4 w-4" />
              )}
              重新打开
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={updatingStatus}
              onClick={() => handleSetStatus("closed")}
            >
              {updatingStatus ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              标记为已处理
            </Button>
          ))}
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {!thread && loading && (
        <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>
      )}

      {!thread && !loading && !error && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          找不到这封邮件。
        </p>
      )}

      {thread && (
        <>
          {/* Subject header */}
          <div className="space-y-1">
            <h1 className="text-lg font-semibold leading-snug">
              {thread.subject || "(无主题)"}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                与 <strong>{thread.counterpartyName || thread.counterpartyEmail}</strong>
              </span>
              {thread.mailboxAddress && (
                <Badge className="text-[10px]">
                  {thread.mailboxAddress}
                </Badge>
              )}
              {thread.status === "closed" && (
                <Badge className="text-[10px]">
                  已处理
                </Badge>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="space-y-3">
            {messages.map((m) => {
              const outbound = m.direction === "outbound";
              const body = m.textBody?.trim() || htmlToText(m.htmlBody || "");
              return (
                <Card
                  key={m.id}
                  className={cn(outbound && "border-amber-200 bg-amber-50/40")}
                >
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-sm">
                        {outbound ? (
                          <ArrowUpRight className="h-3.5 w-3.5 text-amber-600" />
                        ) : (
                          <ArrowDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="font-medium">
                          {m.fromName || m.fromAddress}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          &lt;{m.fromAddress}&gt;
                        </span>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmtFull(m.sentAt || m.createdAt)}
                      </span>
                    </div>
                    {m.toAddresses.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        收件: {m.toAddresses.join(", ")}
                      </p>
                    )}
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
                      {body || "(空内容)"}
                    </pre>
                  </CardContent>
                </Card>
              );
            })}
            {messages.length === 0 && !loading && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                这串对话还没有邮件内容。
              </p>
            )}
          </div>

          {/* Reply composer */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">回复</p>
                <span className="text-xs text-muted-foreground">
                  发送至 {thread.counterpartyName || thread.counterpartyEmail}
                  {thread.mailboxAddress ? ` · 来自 ${thread.mailboxAddress}` : ""}
                </span>
              </div>
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={6}
                placeholder="输入回复内容…"
                disabled={sending}
                className="w-full resize-y rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">
                  通过 Brevo 从 {thread.mailboxAddress || "Hookka"} 发出。
                </p>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={sending || !replyText.trim()}
                  onClick={handleSend}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  发送回复
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
