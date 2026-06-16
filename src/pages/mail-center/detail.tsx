// ---------------------------------------------------------------------------
// Mail Center — thread detail (P1: read-only).
//
// Renders a conversation's messages. Bodies are shown as PLAIN TEXT
// (textBody, or HTML stripped to text) — we never inject untrusted customer
// HTML into the DOM. Reply / assign / resolve arrive in P2.
// ---------------------------------------------------------------------------
import { useParams, useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, Send } from "lucide-react";

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
  const { data, loading, error } = useCachedJson<ThreadDetail>(
    id ? `/api/mail-center/threads/${id}` : null,
    30,
  );

  const thread = data?.thread;
  const messages = data?.messages ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/mail-center")}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          返回收件箱
        </Button>
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

          {/* Reply placeholder — wired in P2 */}
          <Card className="border-dashed">
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <p className="text-sm text-muted-foreground">
                在 ERP 里直接回复 —— P2 上线(通过 Brevo 从这个信箱发出)。
              </p>
              <Button disabled size="sm" className="gap-1.5">
                <Send className="h-4 w-4" />
                回复
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
