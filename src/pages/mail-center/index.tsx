// ---------------------------------------------------------------------------
// Mail Center — shared inbox (2-pane Gmail-like shell + Compose).
//
// Reads /api/mail-center/threads (list) + /api/mail-center/addresses (the
// mailbox sidebar). Bodies are rendered as plain text in the detail view,
// never as raw customer HTML.
//
// LAYOUT (P3 overhaul — strictly ADDITIVE, no route changes):
//   • LEFT RAIL  — a prominent "Compose" button (opens ComposeDialog), the
//                  mailbox list as a vertical sidebar ("All mailboxes" + each
//                  active alias), then the Open/Resolved/All selector and the
//                  search box.
//   • MIDDLE     — the existing thread list (extracted into <ThreadList>).
//   • RIGHT (md+)— a reading pane that embeds detail.tsx for the selected
//                  thread (selection lives in local state, NOT the URL, so the
//                  /mail-center and /mail-center/:id routes are untouched).
//
// Mobile / under-md keeps TODAY's behavior exactly: no pane, tapping a row
// navigates to the standalone /mail-center/:id page. Deep links to
// /mail-center/:id still hit that standalone route (unchanged in routes).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComposeDialog } from "./compose";
import MailCenterDetailPage from "./detail";
import {
  Mail,
  Search,
  RefreshCw,
  Inbox,
  ArrowDownLeft,
  ArrowUpRight,
  CircleDot,
  PenSquare,
  Inbox as InboxIcon,
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

// Track whether we're at the reading-pane breakpoint. The pane needs real
// width for three columns, so it (and the in-pane "select instead of navigate"
// behavior) turns on at lg (1024px) — matching the `lg:block` pane below.
// Under lg we keep today's behavior exactly: tap a row → navigate to the
// standalone /mail-center/:id page. Threshold and CSS MUST agree or a row
// click could select a thread into a pane that isn't visible. SSR-safe default.
const PANE_QUERY = "(min-width: 1024px)";
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(PANE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PANE_QUERY);
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

// ---------------------------------------------------------------------------
// ThreadList — the existing <ul> rows, extracted so both the middle column
// reuses them and selection/active-row highlighting is centralised. Behaviour
// of each row is unchanged from the single-column version; only the click
// target is parameterised (navigate on mobile, select on desktop).
// ---------------------------------------------------------------------------
function ThreadList({
  threads,
  loading,
  activeId,
  onOpen,
  onInjectTest,
}: {
  threads: MailThread[];
  loading: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
  onInjectTest: () => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">
          {loading ? "Loading…" : "No mail yet"}
        </p>
        {!loading && (
          <>
            <p className="max-w-sm text-xs text-muted-foreground/80">
              Incoming mail will appear here once the domain MX is switched to
              Cloudflare and the inbound Worker is live.
            </p>
            <button
              onClick={onInjectTest}
              className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Inject a test email (verify inbox)
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {threads.map((t) => {
        const active = activeId === t.id;
        return (
          <li key={t.id}>
            <button
              onClick={() => onOpen(t.id)}
              className={cn(
                "flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-muted/50",
                active && "bg-amber-50/70 hover:bg-amber-50",
              )}
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
        );
      })}
    </ul>
  );
}

export default function MailCenterPage() {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"open" | "closed" | "all">("open");
  const [mailbox, setMailbox] = useState<string>("");
  const [composeOpen, setComposeOpen] = useState(false);
  // Desktop reading-pane selection. Lives in local state (NOT the URL) so the
  // existing routes stay untouched. Null = show the empty-pane placeholder.
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const activeAddresses = useMemo(
    () => (addresses ?? []).filter((a) => a.active),
    [addresses],
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

  // Per-mailbox unread counts for the sidebar badges.
  const unreadByMailbox = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of threads ?? []) {
      if (!t.unread) continue;
      m.set(t.mailboxAddress, (m.get(t.mailboxAddress) ?? 0) + 1);
    }
    return m;
  }, [threads]);

  // Note: when the selected thread leaves the current filter (e.g. resolved
  // while viewing "Open"), we intentionally KEEP showing it in the pane — the
  // pane fetches by id directly, so the operator can still read/reopen it. The
  // row highlight simply disappears with the row. No state sync needed.

  // Row open: desktop shows it in the reading pane (no navigation); under md we
  // keep today's behavior and navigate to the standalone page.
  function openThread(id: string) {
    if (isDesktop) {
      setSelectedId(id);
    } else {
      navigate(`/mail-center/${id}`);
    }
  }

  async function injectTest() {
    try {
      await fetch("/api/mail-center/test-inject", { method: "POST" });
    } catch {
      /* ignore — refresh just shows nothing changed */
    }
    refresh();
  }

  const composeDisabled = activeAddresses.length === 0;

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

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* 2-pane shell: rail / list / reading-pane. Single column under md. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(320px,420px)_minmax(0,1fr)]">
        {/* LEFT RAIL */}
        <aside className="space-y-3">
          <Button
            variant="primary"
            className="w-full gap-2 bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            onClick={() => setComposeOpen(true)}
            disabled={composeDisabled}
            title={
              composeDisabled
                ? "No mailbox assigned — ask an admin to assign an @hookka.com address"
                : "Write a new email"
            }
          >
            <PenSquare className="h-4 w-4" />
            Compose
          </Button>
          {composeDisabled && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              No mailbox assigned yet — Compose unlocks once an admin assigns you
              an @hookka.com address.
            </p>
          )}

          {/* Mailbox sidebar */}
          <nav className="space-y-0.5">
            <MailboxItem
              label="All mailboxes"
              active={mailbox === ""}
              unread={unreadCount}
              onClick={() => setMailbox("")}
            />
            {activeAddresses.map((a) => (
              <MailboxItem
                key={a.id}
                label={a.label || a.address}
                title={a.address}
                active={mailbox === a.address}
                unread={unreadByMailbox.get(a.address) ?? 0}
                onClick={() => setMailbox(a.address)}
              />
            ))}
          </nav>

          {/* Status selector */}
          <div className="flex items-center gap-1">
            {(["open", "all", "closed"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition",
                  status === s
                    ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {s === "open" ? "Open" : s === "closed" ? "Resolved" : "All"}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search mail…"
              className="pl-8"
            />
          </div>
        </aside>

        {/* MIDDLE — thread list */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <ThreadList
              threads={visible}
              loading={loading}
              activeId={isDesktop ? selectedId : null}
              onOpen={openThread}
              onInjectTest={injectTest}
            />
          </CardContent>
        </Card>

        {/* RIGHT — reading pane (md+ only). Embeds detail.tsx for the selected
            thread. Under md this whole column is hidden and rows navigate to
            the standalone /mail-center/:id page instead. */}
        <div className="hidden min-w-0 lg:block">
          {selectedId ? (
            <Card className="min-w-0">
              <CardContent className="p-4">
                {/* Keyed so switching threads remounts the detail view and its
                    composer/assign state resets cleanly. */}
                <MailCenterDetailPage key={selectedId} id={selectedId} embedded />
              </CardContent>
            </Card>
          ) : (
            <Card className="min-w-0">
              <CardContent className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 py-16 text-center">
                <InboxIcon className="h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm font-medium text-muted-foreground">
                  Select a conversation
                </p>
                <p className="max-w-xs text-xs text-muted-foreground/80">
                  Pick a thread on the left to read it here, or hit Compose to
                  start a new email.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Compose modal — additive overlay; closing returns to the inbox. */}
      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSent={(threadId) => {
          // On desktop, drop the freshly-sent thread straight into the pane.
          if (isDesktop) setSelectedId(threadId);
        }}
      />
    </div>
  );
}

// Sidebar mailbox row with an optional unread count pill.
function MailboxItem({
  label,
  title,
  active,
  unread,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        active
          ? "bg-amber-50 font-medium text-amber-800"
          : "text-foreground/80 hover:bg-muted",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Inbox
          className={cn(
            "h-4 w-4 shrink-0",
            active ? "text-amber-700" : "text-muted-foreground/60",
          )}
        />
        <span className="truncate">{label}</span>
      </span>
      {unread > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-amber-200 text-amber-900" : "bg-muted text-muted-foreground",
          )}
        >
          {unread}
        </span>
      )}
    </button>
  );
}
