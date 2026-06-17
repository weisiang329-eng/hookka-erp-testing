// ---------------------------------------------------------------------------
// Mail Center — shared inbox (3-pane Gmail/Outlook-like client + compose).
//
// Reads /api/mail-center/threads (list) + /api/mail-center/addresses (the
// mailbox sidebar). Bodies are rendered as plain text in the detail view,
// never as raw customer HTML.
//
// LAYOUT:
//   • LEFT RAIL  — "New email" button (opens ComposeDialog), the FOLDER list
//                  (Inbox / Starred / Sent / Archive / Drafts / Trash / All),
//                  a LABELS section (filter by client-side label), then the
//                  mailbox switcher (All mailboxes + per-dept + per-person),
//                  then the search box.
//   • MIDDLE     — the thread list (<ThreadList>) with per-row checkbox + hover
//                  actions, plus a bulk action bar when rows are selected.
//   • RIGHT (lg+)— a reading pane embedding detail.tsx for the selected thread.
//
// FOLDERS vs API STATUS: the backend knows status 'open' / 'closed' plus a
// 'trashed' soft-delete and DB-backed star / labels / unread flags.
//   Inbox   → status=open (server filter)
//   Archive → status=closed (server filter, labelled "Archive")  [= "Done"]
//   Starred → ?starred=1 (server filter)
//   Trash   → ?status=trashed (server filter; excluded from every other view)
//   Sent    → fetched with status=all, narrowed client-side by hasOutbound
//   All     → fetched with status=all
//   Drafts  → local-only compose drafts (no backend draft table — mail-local.ts)
// Star, labels, trash and mark-unread are now DB-backed (PATCH /threads/:id),
// so they sync across users/devices. Only compose drafts remain local.
//
// Mobile / under-lg: tapping a row navigates to the standalone
// /mail-center/:id page (deep links unchanged). The reading pane is lg-only.
// ---------------------------------------------------------------------------
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComposeDialog } from "./compose";
import MailCenterDetailPage from "./detail";
import {
  subscribe as subscribeLocal,
  getSnapshot as getLocalSnapshot,
  deleteDraft,
  type MailDraft,
} from "./mail-local";
import {
  patchManyStatus,
  patchManyTrashed,
  patchManyUnread,
  patchThreadStatus,
  patchThreadStarred,
  patchThreadUnread,
  patchThreadTrashed,
} from "./mail-actions";
import {
  Mail,
  Search,
  RefreshCw,
  Inbox,
  ArrowDownLeft,
  ArrowUpRight,
  PenSquare,
  ChevronRight,
  Users,
  User as UserIcon,
  Check,
  Star,
  Send,
  Archive,
  Trash2,
  FileText,
  Layers,
  Tag,
  MailOpen,
  MailWarning,
  X,
  CheckCheck,
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
  // DB-backed email-client fields (server-side, sync across users/devices).
  starred: boolean;
  labels: string[];
  trashedAt: string | null;
  // Accurate Sent flag — thread has at least one outbound message.
  hasOutbound: boolean;
};

type MailAddress = {
  id: string;
  address: string;
  label: string;
  assignedDept: string | null;
  assignedUserName: string | null;
  active: boolean;
};

// Mailbox sidebar selection. "all" clears the filter (every scoped thread),
// "dept" narrows to all mailboxes in one department, "mailbox" keeps the
// single-address behaviour (drives the ?mailbox= query).
type MailboxFilter =
  | { kind: "all" }
  | { kind: "dept"; value: string }
  | { kind: "mailbox"; value: string };

// Email-client folders. Inbox/Archive map to a server status; the rest are
// resolved client-side (Starred/Sent/Trash/All) or local-only (Drafts).
type Folder =
  | "inbox"
  | "starred"
  | "sent"
  | "archive"
  | "drafts"
  | "trash"
  | "all";

// Department ordering for the sidebar: priority depts first, then A–Z, with
// the catch-all bucket pinned last.
const DEPT_PRIORITY = ["Support", "Finance", "HR"];
const UNASSIGNED_DEPT = "Other";

function deptRank(dept: string): number {
  const i = DEPT_PRIORITY.indexOf(dept);
  if (i !== -1) return i;
  if (dept === UNASSIGNED_DEPT) return DEPT_PRIORITY.length + 1;
  return DEPT_PRIORITY.length;
}

function sortDepts(a: string, b: string): number {
  const ra = deptRank(a);
  const rb = deptRank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

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

// Best-effort display name for a thread's counterparty so the list never shows
// a bare "(unknown sender)" when we actually hold an address. Falls back to the
// local-part of the email, then a neutral placeholder.
function senderLabel(t: MailThread): string {
  const name = t.counterpartyName?.trim();
  if (name) return name;
  const email = t.counterpartyEmail?.trim();
  if (email) {
    const local = email.split("@")[0];
    return local || email;
  }
  return "(no sender)";
}

// The reading pane needs real width for three columns, so it turns on at lg.
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

// Subscribe the whole page to the local DRAFTS store (star/label/trash/read are
// now DB-backed and arrive on the thread rows themselves).
function useLocalMail() {
  return useSyncExternalStore(subscribeLocal, getLocalSnapshot, getLocalSnapshot);
}

// ---------------------------------------------------------------------------
// ThreadList — the thread rows. Each row has a leading checkbox (bulk select),
// the unread/star column, the sender + subject + snippet, label chips, and a
// hover action cluster (star / read-unread / archive-or-inbox / trash).
// ---------------------------------------------------------------------------
function ThreadList({
  threads,
  loading,
  activeId,
  folder,
  selectedIds,
  onToggleSelect,
  onOpen,
  onInjectTest,
  onRowAction,
}: {
  threads: MailThread[];
  loading: boolean;
  activeId: string | null;
  folder: Folder;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onInjectTest: () => void;
  onRowAction: (action: RowAction, t: MailThread) => void;
}) {
  if (threads.length === 0) {
    // Quiet, compact empty state — a normal list column that happens to be
    // empty, NOT a giant card. Gmail/Outlook show a small muted line here.
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
        <Inbox className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-xs font-medium text-muted-foreground">
          {loading ? "Loading…" : emptyLabel(folder)}
        </p>
        {!loading && folder === "inbox" && (
          <>
            <p className="max-w-xs text-[11px] leading-snug text-muted-foreground/70">
              Incoming mail will appear here once the domain MX is switched to
              Cloudflare and the inbound Worker is live.
            </p>
            <button
              onClick={onInjectTest}
              className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
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
        const starred = t.starred;
        const unread = t.unread;
        const chips = t.labels;
        const selected = selectedIds.has(t.id);
        return (
          <li
            key={t.id}
            className={cn(
              "group relative flex items-stretch border-l-2 transition",
              active
                ? "border-amber-500 bg-amber-50/70"
                : selected
                  ? "border-amber-400 bg-amber-50/40"
                  : unread
                    ? "border-amber-400 bg-amber-50/30"
                    : "border-transparent hover:bg-muted/50",
            )}
          >
            {/* Select checkbox — its own click target, never opens the row. */}
            <label
              className="flex cursor-pointer items-center pl-3 pr-1"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(t.id)}
                aria-label={`Select conversation with ${senderLabel(t)}`}
                className="h-3.5 w-3.5 cursor-pointer rounded border-[#C9C2BA] text-[#6B5C32] focus:ring-[#6B5C32]/30"
              />
            </label>

            {/* Star toggle — DB-backed (PATCH starred). */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRowAction(starred ? "unstar" : "star", t);
              }}
              aria-label={starred ? "Unstar" : "Star"}
              title={starred ? "Unstar" : "Star"}
              className="flex items-center px-1 text-muted-foreground/40 hover:text-amber-500"
            >
              <Star
                className={cn(
                  "h-4 w-4",
                  starred && "fill-amber-400 text-amber-500",
                )}
              />
            </button>

            <button
              onClick={() => onOpen(t.id)}
              className="flex min-w-0 flex-1 items-start gap-2 py-3 pr-2 text-left"
            >
              {/* Unread dot / direction arrow column. */}
              <div className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center">
                {unread ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                ) : t.lastDirection === "outbound" ? (
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                ) : (
                  <ArrowDownLeft className="h-3.5 w-3.5 text-muted-foreground/50" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      unread
                        ? "font-semibold text-foreground"
                        : "font-medium text-foreground/90",
                    )}
                  >
                    {senderLabel(t)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {fmtTime(t.lastMessageAt)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-sm",
                      unread ? "text-foreground" : "text-muted-foreground",
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
                {chips.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {chips.map((l) => (
                      <span
                        key={l}
                        className="inline-flex items-center gap-1 rounded-full bg-[#EFE9DD] px-1.5 py-0.5 text-[10px] font-medium text-[#6B5C32] ring-1 ring-inset ring-[#E2DDD8]"
                      >
                        <Tag className="h-2.5 w-2.5" />
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Mailbox + status. Status VALUE stays 'closed'; the chip reads
                  "Archived" to match the folder name. */}
              <div className="ml-1 flex shrink-0 flex-col items-end gap-1">
                {t.mailboxAddress && (
                  <Badge className="max-w-[150px] truncate text-[10px]">
                    {t.mailboxAddress}
                  </Badge>
                )}
                {t.status === "closed" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    <Check className="h-3 w-3" />
                    Archived
                  </span>
                )}
              </div>
            </button>

            {/* Hover action cluster — appears on row hover (always visible on
                touch via focus-within). */}
            <div className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              <RowIconButton
                title={unread ? "Mark as read" : "Mark as unread"}
                onClick={() => onRowAction(unread ? "read" : "unread", t)}
              >
                {unread ? (
                  <MailOpen className="h-4 w-4" />
                ) : (
                  <MailWarning className="h-4 w-4" />
                )}
              </RowIconButton>
              {folder !== "trash" &&
                (t.status === "closed" ? (
                  <RowIconButton
                    title="Move to Inbox"
                    onClick={() => onRowAction("inbox", t)}
                  >
                    <Inbox className="h-4 w-4" />
                  </RowIconButton>
                ) : (
                  <RowIconButton
                    title="Archive (mark done)"
                    onClick={() => onRowAction("archive", t)}
                  >
                    <Archive className="h-4 w-4" />
                  </RowIconButton>
                ))}
              {folder === "trash" ? (
                <RowIconButton
                  title="Restore from Trash"
                  onClick={() => onRowAction("restore", t)}
                >
                  <RotateIcon />
                </RowIconButton>
              ) : (
                <RowIconButton
                  title="Move to Trash"
                  onClick={() => onRowAction("trash", t)}
                >
                  <Trash2 className="h-4 w-4" />
                </RowIconButton>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type RowAction =
  | "star"
  | "unstar"
  | "read"
  | "unread"
  | "archive"
  | "inbox"
  | "trash"
  | "restore";

function RowIconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1.5 text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

// Small inline "restore" glyph (reuse lucide RotateCcw look without another
// import name clash) — a circular arrow.
function RotateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function emptyLabel(folder: Folder): string {
  switch (folder) {
    case "starred":
      return "No starred mail";
    case "sent":
      return "No sent mail";
    case "archive":
      return "Nothing archived";
    case "drafts":
      return "No drafts";
    case "trash":
      return "Trash is empty";
    case "all":
      return "No mail";
    default:
      return "No mail yet";
  }
}

// ---------------------------------------------------------------------------
// Drafts list — local-only saved compose drafts (no backend draft store).
// Resuming a draft re-opens the compose dialog pre-filled.
// ---------------------------------------------------------------------------
function DraftsList({
  drafts,
  onResume,
}: {
  drafts: MailDraft[];
  onResume: (d: MailDraft) => void;
}) {
  if (drafts.length === 0) {
    // Compact, quiet empty state to match the thread list (no giant card).
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
        <FileText className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-xs font-medium text-muted-foreground">No drafts</p>
        <p className="max-w-xs text-[11px] leading-snug text-muted-foreground/70">
          Start a new email and choose “Save draft” to keep it here. Drafts are
          stored on this device only.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {drafts.map((d) => (
        <li key={d.id} className="group flex items-stretch hover:bg-muted/50">
          <button
            onClick={() => onResume(d)}
            className="flex min-w-0 flex-1 items-start gap-2 px-4 py-3 text-left"
          >
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground/90">
                  {d.subject?.trim() || "(no subject)"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {fmtTime(new Date(d.updatedAt).toISOString())}
                </span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                To {d.to?.trim() || "—"}
              </p>
              {d.body && (
                <p className="truncate text-xs text-muted-foreground/80">
                  {d.body}
                </p>
              )}
            </div>
          </button>
          <div className="flex shrink-0 items-center pr-2 opacity-0 transition group-hover:opacity-100">
            <RowIconButton
              title="Discard draft"
              onClick={() => deleteDraft(d.id)}
            >
              <Trash2 className="h-4 w-4" />
            </RowIconButton>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function MailCenterPage() {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const local = useLocalMail();

  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [filter, setFilter] = useState<MailboxFilter>({ kind: "all" });
  const [composeOpen, setComposeOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<MailDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Map folder → the server status param. Inbox/Archive/Trash filter
  // server-side; Starred/Sent/All fetch the full (non-trashed) set and narrow
  // client-side; Drafts doesn't hit the threads endpoint at all. Trashed rows
  // are excluded from every non-Trash view by the backend.
  const apiStatus: "open" | "closed" | "trashed" | "all" =
    folder === "inbox"
      ? "open"
      : folder === "archive"
        ? "closed"
        : folder === "trash"
          ? "trashed"
          : "all";

  const params = new URLSearchParams();
  if (apiStatus !== "all") params.set("status", apiStatus);
  if (filter.kind === "mailbox") params.set("mailbox", filter.value);
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
  // Dedicated trashed fetch — drives the Trash folder badge from ANY folder
  // (the main list excludes trashed rows server-side, so it can't be counted
  // from there). Mirrors the mailbox filter so the badge tracks the current
  // mailbox scope.
  const trashCountUrl = `/api/mail-center/threads?status=trashed${
    filter.kind === "mailbox" ? `&mailbox=${encodeURIComponent(filter.value)}` : ""
  }`;
  const { data: trashedThreads } = useCachedJson<MailThread[]>(
    trashCountUrl,
    60,
  );

  const activeAddresses = useMemo(
    () => (addresses ?? []).filter((a) => a.active),
    [addresses],
  );

  // Group active mailboxes by department for the hierarchical switcher.
  const deptGroups = useMemo(() => {
    const byDept = new Map<string, MailAddress[]>();
    for (const a of activeAddresses) {
      const dept = (a.assignedDept ?? "").trim() || UNASSIGNED_DEPT;
      const arr = byDept.get(dept);
      if (arr) arr.push(a);
      else byDept.set(dept, [a]);
    }
    return Array.from(byDept.entries())
      .map(([dept, mailboxes]) => ({
        dept,
        mailboxes: mailboxes
          .slice()
          .sort((x, y) =>
            (x.assignedUserName || x.address).localeCompare(
              y.assignedUserName || y.address,
            ),
          ),
      }))
      .sort((a, b) => sortDepts(a.dept, b.dept));
  }, [activeAddresses]);

  const addressesByDept = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const g of deptGroups) {
      m.set(g.dept, new Set(g.mailboxes.map((a) => a.address)));
    }
    return m;
  }, [deptGroups]);

  // Client-side narrowing of the already-scoped list. Trash and status are now
  // resolved server-side (the fetched set is already the right folder), so this
  // only layers on:
  //   1. Folder semantics — Starred (DB star) / Sent (hasOutbound) on top of
  //      the server status the list was fetched with.
  //   2. Department filter — when a whole dept is selected.
  //   3. Label filter — when a sidebar label is active (DB labels).
  //   4. Text search over subject / sender name / sender email / snippet.
  const visible = useMemo(() => {
    let list = threads ?? [];

    // Folder-specific client narrowing.
    if (folder === "starred") {
      list = list.filter((t) => t.starred);
    } else if (folder === "sent") {
      // Accurate Sent: thread has at least one outbound message (server-computed
      // hasOutbound), not the last_direction proxy.
      list = list.filter((t) => t.hasOutbound);
    }

    // Department narrowing.
    if (filter.kind === "dept") {
      const addrs = addressesByDept.get(filter.value);
      list = addrs ? list.filter((t) => addrs.has(t.mailboxAddress)) : [];
    }

    // Label filter.
    if (labelFilter) {
      list = list.filter((t) =>
        t.labels.some((l) => l.toLowerCase() === labelFilter.toLowerCase()),
      );
    }

    // Text search.
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (t) =>
          t.subject.toLowerCase().includes(needle) ||
          t.counterpartyEmail.toLowerCase().includes(needle) ||
          t.counterpartyName.toLowerCase().includes(needle) ||
          t.lastSnippet.toLowerCase().includes(needle),
      );
    }

    return list;
  }, [threads, q, folder, filter, addressesByDept, labelFilter]);

  // Counts for the folder list. inbox-unread / starred are computed off the
  // FETCHED set (so they reflect the current mailbox scope), filtered to the
  // LIVE (non-trashed) rows — the backend already excludes trashed rows from
  // every non-Trash fetch, so on the Trash folder these read 0 until the user
  // leaves it. The trash badge comes from its own dedicated fetch so it stays
  // accurate from any folder.
  const liveThreads = useMemo(
    () => (threads ?? []).filter((t) => !t.trashedAt),
    [threads],
  );

  const folderCounts = useMemo(() => {
    const inboxUnread = liveThreads.filter(
      (t) => t.status === "open" && t.unread,
    ).length;
    return {
      inboxUnread,
      starred: liveThreads.filter((t) => t.starred).length,
      trash: (trashedThreads ?? []).length,
    };
  }, [liveThreads, trashedThreads]);

  const unreadCount = liveThreads.filter((t) => t.unread).length;

  // Per-mailbox + per-dept unread counts for the mailbox switcher badges.
  const unreadByMailbox = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of liveThreads) {
      if (!t.unread) continue;
      m.set(t.mailboxAddress, (m.get(t.mailboxAddress) ?? 0) + 1);
    }
    return m;
  }, [liveThreads]);

  const unreadByDept = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of deptGroups) {
      let n = 0;
      for (const a of g.mailboxes) n += unreadByMailbox.get(a.address) ?? 0;
      m.set(g.dept, n);
    }
    return m;
  }, [deptGroups, unreadByMailbox]);

  // Distinct labels across the loaded (live) threads, sorted, for the sidebar
  // filter list. Derived from the DB-backed per-thread labels.
  const labels = useMemo(() => {
    const set = new Set<string>();
    for (const t of liveThreads) for (const l of t.labels) set.add(l);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [liveThreads]);
  const drafts = local.drafts;

  // The selection set may hold ids that are no longer visible (folder switch,
  // search). Rather than prune it in an effect (which causes a cascading
  // render), we DERIVE the effective selection as the intersection with the
  // current visible list. Every consumer below uses this derived set, so a
  // hidden-but-still-checked id never leaks into counts or bulk actions.
  const selectedArr = useMemo(
    () => visible.filter((t) => selectedIds.has(t.id)),
    [visible, selectedIds],
  );
  const selectedVisibleIds = useMemo(
    () => new Set(selectedArr.map((t) => t.id)),
    [selectedArr],
  );
  const selectedCount = selectedArr.length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds(new Set(visible.map((t) => t.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openThread(id: string) {
    // Opening a thread marks it read server-side (GET /threads/:id clears the
    // unread flag); the detail view invalidates the list cache so the row
    // reflects that on the next read.
    if (isDesktop) {
      setSelectedId(id);
    } else {
      navigate(`/mail-center/${id}`);
    }
  }

  // Single-row hover actions. All DB-backed via PATCH /threads/:id.
  async function onRowAction(action: RowAction, t: MailThread) {
    switch (action) {
      case "star": {
        const ok = await patchThreadStarred(t.id, true);
        if (!ok) toast.error("Couldn’t star. Please try again.");
        break;
      }
      case "unstar": {
        const ok = await patchThreadStarred(t.id, false);
        if (!ok) toast.error("Couldn’t unstar. Please try again.");
        break;
      }
      case "read": {
        const ok = await patchThreadUnread(t.id, false);
        if (!ok) toast.error("Couldn’t update. Please try again.");
        break;
      }
      case "unread": {
        const ok = await patchThreadUnread(t.id, true);
        toast[ok ? "success" : "error"](
          ok ? "Marked as unread." : "Couldn’t update. Please try again.",
        );
        break;
      }
      case "archive": {
        const ok = await patchThreadStatus(t.id, "closed");
        toast[ok ? "success" : "error"](
          ok ? "Archived." : "Couldn’t archive. Please try again.",
        );
        break;
      }
      case "inbox": {
        const ok = await patchThreadStatus(t.id, "open");
        toast[ok ? "success" : "error"](
          ok ? "Moved to Inbox." : "Couldn’t move. Please try again.",
        );
        break;
      }
      case "trash": {
        const ok = await patchThreadTrashed(t.id, true);
        if (ok) {
          if (selectedId === t.id) setSelectedId(null);
          toast.info("Moved to Trash.");
        } else {
          toast.error("Couldn’t move to Trash. Please try again.");
        }
        break;
      }
      case "restore": {
        const ok = await patchThreadTrashed(t.id, false);
        toast[ok ? "info" : "error"](
          ok ? "Restored from Trash." : "Couldn’t restore. Please try again.",
        );
        break;
      }
    }
  }

  // ── Bulk actions over the current selection (selectedArr is derived above
  // as the visible-intersection, so these never touch hidden rows). ─────────
  async function bulkStatus(status: "open" | "closed") {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const ok = await patchManyStatus(ids, status);
    const verb = status === "closed" ? "archived" : "moved to Inbox";
    if (ok === ids.length) toast.success(`${ok} ${verb}.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} ${verb}.`);
    else toast.error(`Couldn’t update. Please try again.`);
    clearSelection();
  }

  async function bulkRead(value: boolean) {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const ok = await patchManyUnread(ids, value);
    const verb = value ? "unread" : "read";
    if (ok === ids.length) toast.success(`${ok} marked as ${verb}.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} marked as ${verb}.`);
    else toast.error("Couldn’t update. Please try again.");
    clearSelection();
  }

  async function bulkTrash() {
    const ids = selectedArr.map((t) => t.id);
    if (ids.length === 0) return;
    const confirmed = await confirm({
      title: `Move ${ids.length} ${ids.length === 1 ? "conversation" : "conversations"} to Trash?`,
      message:
        "They’ll move to the Trash folder. You can restore them from there.",
      confirmLabel: "Move to Trash",
      tone: "danger",
    });
    if (!confirmed) return;
    const ok = await patchManyTrashed(ids, true);
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    if (ok === ids.length) toast.info(`${ok} moved to Trash.`);
    else if (ok > 0) toast.warning(`${ok} of ${ids.length} moved to Trash.`);
    else toast.error("Couldn’t move to Trash. Please try again.");
    clearSelection();
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
  const allVisibleSelected =
    visible.length > 0 && selectedCount >= visible.length;

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

      {/* 3-pane shell: rail / list / reading-pane (Gmail/Outlook proportions —
          folders rail, a fixed-ish list column ~360-400px, then a flex-1
          reading pane). Single column under md. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[210px_minmax(0,1fr)] lg:grid-cols-[230px_minmax(360px,400px)_minmax(0,1fr)]">
        {/* LEFT RAIL */}
        <aside className="space-y-3">
          <Button
            variant="primary"
            className="w-full gap-2 rounded-full bg-[#6B5C32] py-2.5 text-white shadow-sm hover:bg-[#5a4d2a]"
            onClick={() => {
              setResumeDraft(null);
              setComposeOpen(true);
            }}
            disabled={composeDisabled}
            title={
              composeDisabled
                ? "No mailbox assigned — ask an admin to assign an @hookka.com address"
                : "Write a new email"
            }
          >
            <PenSquare className="h-4 w-4" />
            New email
          </Button>
          {composeDisabled && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              No mailbox assigned yet — "New email" unlocks once an admin assigns
              you an @hookka.com address.
            </p>
          )}

          {/* FOLDERS */}
          <nav className="space-y-0.5">
            <FolderItem
              icon={Inbox}
              label="Inbox"
              active={folder === "inbox"}
              badge={folderCounts.inboxUnread}
              onClick={() => {
                setFolder("inbox");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={Star}
              label="Starred"
              active={folder === "starred"}
              badge={folderCounts.starred}
              badgeTone="muted"
              onClick={() => {
                setFolder("starred");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={Send}
              label="Sent"
              active={folder === "sent"}
              onClick={() => {
                setFolder("sent");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={Archive}
              label="Archive"
              active={folder === "archive"}
              onClick={() => {
                setFolder("archive");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={FileText}
              label="Drafts"
              active={folder === "drafts"}
              badge={drafts.length}
              badgeTone="muted"
              onClick={() => {
                setFolder("drafts");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={Trash2}
              label="Trash"
              active={folder === "trash"}
              badge={folderCounts.trash}
              badgeTone="muted"
              onClick={() => {
                setFolder("trash");
                setLabelFilter(null);
              }}
            />
            <FolderItem
              icon={Layers}
              label="All mail"
              active={folder === "all"}
              onClick={() => {
                setFolder("all");
                setLabelFilter(null);
              }}
            />
          </nav>

          {/* LABELS — client-side categories. Selecting one filters the list. */}
          {labels.length > 0 && (
            <div className="space-y-0.5">
              <p className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Labels
              </p>
              {labels.map((l) => (
                <button
                  key={l}
                  onClick={() => setLabelFilter(labelFilter === l ? null : l)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition",
                    labelFilter === l
                      ? "bg-amber-50 font-medium text-amber-800"
                      : "text-foreground/80 hover:bg-muted",
                  )}
                >
                  <Tag
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      labelFilter === l
                        ? "text-amber-700"
                        : "text-muted-foreground/60",
                    )}
                  />
                  <span className="truncate">{l}</span>
                </button>
              ))}
            </div>
          )}

          {/* MAILBOX SWITCHER */}
          <div className="space-y-0.5 border-t border-border/60 pt-2">
            <p className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Mailboxes
            </p>
            <MailboxItem
              label="All mailboxes"
              active={filter.kind === "all"}
              unread={unreadCount}
              onClick={() => setFilter({ kind: "all" })}
            />
            {deptGroups.map((g) => (
              <DeptGroup
                key={g.dept}
                dept={g.dept}
                mailboxes={g.mailboxes}
                filter={filter}
                unreadByMailbox={unreadByMailbox}
                unreadForDept={unreadByDept.get(g.dept) ?? 0}
                onSelectDept={() => setFilter({ kind: "dept", value: g.dept })}
                onSelectMailbox={(address) =>
                  setFilter({ kind: "mailbox", value: address })
                }
              />
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

        {/* MIDDLE — thread list (or drafts list) */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {/* List toolbar: select-all + bulk action bar. Hidden for Drafts. */}
            {folder !== "drafts" && visible.length > 0 && (
              <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    aria-label="Select all"
                    onChange={() =>
                      allVisibleSelected ? clearSelection() : selectAllVisible()
                    }
                    className="h-3.5 w-3.5 cursor-pointer rounded border-[#C9C2BA] text-[#6B5C32] focus:ring-[#6B5C32]/30"
                  />
                  {selectedCount > 0 ? `${selectedCount} selected` : "Select"}
                </label>
                <span className="text-[11px] text-muted-foreground/70">
                  {visible.length}{" "}
                  {visible.length === 1 ? "conversation" : "conversations"}
                </span>
              </div>
            )}

            {selectedCount > 0 && folder !== "drafts" && (
              <BulkBar
                count={selectedCount}
                folder={folder}
                onArchive={() => bulkStatus("closed")}
                onInbox={() => bulkStatus("open")}
                onRead={() => bulkRead(false)}
                onUnread={() => bulkRead(true)}
                onTrash={bulkTrash}
                onClear={clearSelection}
              />
            )}

            {folder === "drafts" ? (
              <DraftsList
                drafts={drafts}
                onResume={(d) => {
                  setResumeDraft(d);
                  setComposeOpen(true);
                }}
              />
            ) : (
              <ThreadList
                threads={visible}
                loading={loading}
                activeId={isDesktop ? selectedId : null}
                folder={folder}
                selectedIds={selectedVisibleIds}
                onToggleSelect={toggleSelect}
                onOpen={openThread}
                onInjectTest={injectTest}
                onRowAction={onRowAction}
              />
            )}
          </CardContent>
        </Card>

        {/* RIGHT — reading pane (lg+ only). When a thread is selected it shows
            the conversation in a card; when nothing is selected it's a simple
            borderless, centered placeholder (no card, no compose button — the
            sidebar "New email" is the single compose entry, Gmail/Outlook
            style). */}
        <div className="hidden min-w-0 lg:block">
          {selectedId ? (
            <Card className="min-w-0">
              <CardContent className="p-4">
                <MailCenterDetailPage key={selectedId} id={selectedId} embedded />
              </CardContent>
            </Card>
          ) : (
            <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 px-6 text-center">
              <Mail className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                Select a conversation to read it here
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Compose modal — additive overlay; closing returns to the inbox. */}
      <ComposeDialog
        open={composeOpen}
        initialDraft={resumeDraft}
        onClose={() => {
          setComposeOpen(false);
          setResumeDraft(null);
        }}
        onSent={(threadId) => {
          if (isDesktop) setSelectedId(threadId);
        }}
      />

      {confirmDialog}
    </div>
  );
}

// ── Folder row ──────────────────────────────────────────────────────────────
function FolderItem({
  icon: Icon,
  label,
  active,
  badge,
  badgeTone = "accent",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  badge?: number;
  badgeTone?: "accent" | "muted";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        active
          ? "bg-amber-50 font-semibold text-amber-800"
          : "text-foreground/80 hover:bg-muted",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            active ? "text-amber-700" : "text-muted-foreground/60",
          )}
        />
        <span className="truncate">{label}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            badgeTone === "accent"
              ? active
                ? "bg-amber-200 text-amber-900"
                : "bg-amber-100 text-amber-800"
              : active
                ? "bg-amber-200 text-amber-900"
                : "bg-muted text-muted-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Bulk action bar ─────────────────────────────────────────────────────────
function BulkBar({
  count,
  folder,
  onArchive,
  onInbox,
  onRead,
  onUnread,
  onTrash,
  onClear,
}: {
  count: number;
  folder: Folder;
  onArchive: () => void;
  onInbox: () => void;
  onRead: () => void;
  onUnread: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-amber-200 bg-amber-50/70 px-3 py-2">
      <span className="mr-1 text-xs font-medium text-amber-900">
        {count} selected
      </span>
      {folder === "archive" ? (
        <BulkButton icon={Inbox} label="Move to Inbox" onClick={onInbox} />
      ) : folder !== "trash" ? (
        <BulkButton icon={Archive} label="Archive" onClick={onArchive} />
      ) : null}
      <BulkButton icon={MailOpen} label="Read" onClick={onRead} />
      <BulkButton icon={MailWarning} label="Unread" onClick={onUnread} />
      {folder !== "trash" && (
        <BulkButton icon={Trash2} label="Trash" onClick={onTrash} />
      )}
      <button
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-800 transition hover:bg-amber-100"
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </button>
    </div>
  );
}

function BulkButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ── Mailbox switcher rows (unchanged behaviour) ─────────────────────────────
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
        <MailboxAllIcon active={active} />
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

function MailboxAllIcon({ active }: { active: boolean }) {
  return (
    <CheckCheck
      className={cn(
        "h-4 w-4 shrink-0",
        active ? "text-amber-700" : "text-muted-foreground/60",
      )}
    />
  );
}

function DeptGroup({
  dept,
  mailboxes,
  filter,
  unreadByMailbox,
  unreadForDept,
  onSelectDept,
  onSelectMailbox,
}: {
  dept: string;
  mailboxes: MailAddress[];
  filter: MailboxFilter;
  unreadByMailbox: Map<string, number>;
  unreadForDept: number;
  onSelectDept: () => void;
  onSelectMailbox: (address: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const deptActive = filter.kind === "dept" && filter.value === dept;

  return (
    <div>
      <div
        className={cn(
          "flex w-full items-center gap-1 rounded-md pr-2 text-sm transition",
          deptActive
            ? "bg-amber-50 font-medium text-amber-800"
            : "text-foreground/80 hover:bg-muted",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? `Collapse ${dept}` : `Expand ${dept}`}
          aria-expanded={expanded}
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground/70 hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          onClick={onSelectDept}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Users
              className={cn(
                "h-4 w-4 shrink-0",
                deptActive ? "text-amber-700" : "text-muted-foreground/60",
              )}
            />
            <span className="truncate font-medium">{dept}</span>
            <span className="shrink-0 text-[11px] font-normal text-muted-foreground/70">
              {mailboxes.length}
            </span>
          </span>
          {unreadForDept > 0 && (
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                deptActive
                  ? "bg-amber-200 text-amber-900"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {unreadForDept}
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="ml-3 space-y-0.5 border-l border-border/60 pl-2">
          {mailboxes.map((a) => {
            const mailboxActive =
              filter.kind === "mailbox" && filter.value === a.address;
            return (
              <PersonItem
                key={a.id}
                label={a.assignedUserName || a.address}
                title={a.address}
                active={mailboxActive}
                unread={unreadByMailbox.get(a.address) ?? 0}
                onClick={() => onSelectMailbox(a.address)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PersonItem({
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
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
        active
          ? "bg-amber-50 font-medium text-amber-800"
          : "text-foreground/75 hover:bg-muted",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <UserIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-amber-700" : "text-muted-foreground/50",
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
