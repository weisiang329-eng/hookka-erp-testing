// ---------------------------------------------------------------------------
// Mail Center — shared inbox (P1: read-only thread list).
//
// Reads /api/mail-center/threads (list) + /api/mail-center/addresses (the
// mailbox filter chips). Replying, assigning and alias management land in
// later phases. Bodies are rendered as plain text in the detail view, never
// as raw customer HTML.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Mail,
  Search,
  RefreshCw,
  Inbox,
  ArrowDownLeft,
  ArrowUpRight,
  CircleDot,
} from "lucide-react";

type MailThread = {
  id: string;
  mailboxAddress: string;
  subject: string;
  counterpartyEmail: string;
  counterpartyName: string;
  status: string;
  lastMessageAt: string;
  lastDirection: string;
  lastSnippet: string;
  messageCount: number;
  unread: boolean;
};

type MailAddress = {
  id: string;
  address: string;
  label: string;
  active: boolean;
};

function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}

export default function MailCenterPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"open" | "closed" | "all">("open");
  const [mailbox, setMailbox] = useState<string>("");

  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (mailbox) params.set("mailbox", mailbox);
  const listUrl = `/api/mail-center/threads${params.toString() ? `?${params.toString()}` : ""}`;

  const {
    data: threads,
    loading,
    error,
    refresh,
  } = useCachedJson<MailThread[]>(listUrl, 60);
  const { data: addresses } = useCachedJson<MailAddress[]>(
    "/api/mail-center/addresses",
    300,
  );

  // Client-side text search over the already-scoped list (subject / sender /
  // snippet) so typing feels instant without a roundtrip per keystroke.
  const visible = useMemo(() => {
    const list = threads ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (t) =>
        t.subject.toLowerCase().includes(needle) ||
        t.counterpartyEmail.toLowerCase().includes(needle) ||
        t.counterpartyName.toLowerCase().includes(needle) ||
        t.lastSnippet.toLowerCase().includes(needle),
    );
  }, [threads, q]);

  const unreadCount = (threads ?? []).filter((t) => t.unread).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className="h-6 w-6 text-amber-700" />
          <div>
            <h1 className="text-xl font-semibold leading-tight">Mail Center</h1>
            <p className="text-xs text-muted-foreground">
              Shared inbox · all customer email in one place
              {unreadCount > 0 ? ` · ${unreadCount} unread` : ""}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} className="gap-1.5">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Mailbox filter chips */}
      {addresses && addresses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setMailbox("")}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              mailbox === ""
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            All mailboxes
          </button>
          {addresses
            .filter((a) => a.active)
            .map((a) => (
              <button
                key={a.id}
                onClick={() => setMailbox(a.address)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  mailbox === a.address
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
                title={a.address}
              >
                {a.label || a.address}
              </button>
            ))}
        </div>
      )}

      {/* Search + status */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search subject / sender / content…"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1">
          {(["open", "all", "closed"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition",
                status === s
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {s === "open" ? "Open" : s === "closed" ? "Resolved" : "All"}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* Thread list */}
      <Card>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm font-medium text-muted-foreground">
                {loading ? "Loading…" : "No mail yet"}
              </p>
              {!loading && (
                <>
                  <p className="max-w-sm text-xs text-muted-foreground/80">
                    Incoming mail will appear here once the domain MX is
                    switched to Cloudflare and the inbound Worker is live.
                  </p>
                  <button
                    onClick={async () => {
                      try {
                        await fetch("/api/mail-center/test-inject", {
                          method: "POST",
                        });
                      } catch {
                        /* ignore — refresh just shows nothing changed */
                      }
                      refresh();
                    }}
                    className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                  >
                    Inject a test email (verify inbox)
                  </button>
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => navigate(`/mail-center/${t.id}`)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-muted/50"
                  >
                    {/* Unread dot / direction */}
                    <div className="mt-1 shrink-0">
                      {t.unread ? (
                        <CircleDot className="h-4 w-4 text-amber-600" />
                      ) : t.lastDirection === "outbound" ? (
                        <ArrowUpRight className="h-4 w-4 text-muted-foreground/60" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4 text-muted-foreground/60" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-sm",
                            t.unread
                              ? "font-semibold text-foreground"
                              : "font-medium text-foreground/90",
                          )}
                        >
                          {t.counterpartyName || t.counterpartyEmail || "(unknown sender)"}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {fmtTime(t.lastMessageAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-sm",
                            t.unread ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t.subject}
                        </span>
                        {t.messageCount > 1 && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            ({t.messageCount})
                          </span>
                        )}
                      </div>
                      {t.lastSnippet && (
                        <p className="truncate text-xs text-muted-foreground/80">
                          {t.lastSnippet}
                        </p>
                      )}
                    </div>

                    {/* Mailbox + status */}
                    <div className="ml-1 flex shrink-0 flex-col items-end gap-1">
                      {t.mailboxAddress && (
                        <Badge className="max-w-[160px] truncate text-[10px]">
                          {t.mailboxAddress}
                        </Badge>
                      )}
                      {t.status === "closed" && (
                        <span className="text-[10px] text-muted-foreground">Resolved</span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
