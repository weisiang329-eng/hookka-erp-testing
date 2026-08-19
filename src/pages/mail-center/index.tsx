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
//
// GMAIL-STYLE VIEW TOGGLES (mail-prefs.ts, localStorage-persisted, surfaced via
// the header "View" gear — these ARE the owner's "可以开关"; we did NOT fork two
// full layouts, we made ONE layout configurable to keep the risk low):
//   • DENSITY      — "compact" (Gmail single-line rows, the default) vs
//                    "comfortable" (the original taller multi-line cards). The
//                    ThreadList renders CompactRow vs ComfortableRow; both share
//                    RowLead (checkbox+star) + RowActions (hover cluster).
//   • READING PANE — "split" (list + right reading pane, the 3-pane default) vs
//                    "full" (full-width list; a row opens /mail-center/:id). The
//                    grid drops its 3rd column and openThread navigates in full.
//   • CATEGORY TABS— All / Primary / Notifications strip above the list. A
//                    CLIENT-SIDE sender heuristic (classifyCategory in
//                    mail-prefs.ts) over the already-fetched rows — no backend
//                    columns. Toggle hides the strip (and clears its filter).
// Everything else (reply/forward/star/unread/archive/trash, labels, Assign,
// mailbox+dept scoping, unread counts, search, pagination) is unchanged.
// ---------------------------------------------------------------------------
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";
import { csrfHeaders } from "@/lib/csrf";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIncrementalList } from "@/components/ui/incremental-list";
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
  patchManyAddLabel,
  patchThreadStatus,
  patchThreadStarred,
  patchThreadUnread,
  patchThreadTrashed,
  createLabel,
  updateLabel,
  deleteLabel,
  createDeptMailbox,
} from "./mail-actions";
import {
  type MailLabel,
  LABEL_PALETTE,
  labelColorMap,
  colorForLabel,
  chipStyle,
} from "./mail-labels";
import {
  type MailViewPrefs,
  type MailDensity,
  type MailReadingPane,
  type MailCategory,
  classifyCategory,
  subscribePrefs,
  getPrefsSnapshot,
  setDensity,
  setReadingPane,
  setCategoryTabs,
} from "./mail-prefs";
import {
  Mail,
  Search,
  RefreshCw,
  Inbox,
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  Paperclip,
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
  Plus,
  Building2,
  Settings2,
  SlidersHorizontal,
  Bell,
  Rows3,
  Rows4,
  PanelRight,
  Square,
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

// A mailbox row in a department group: either a REAL address row, or a MISSING
// canonical shared mailbox (support@/finance@/hr@ that hasn't been created yet)
// shown as a placeholder the admin can one-click set up.
type MailboxEntry =
  | { kind: "real"; address: MailAddress }
  | { kind: "missing"; address: string; dept: string };

// Email-client folders. Inbox/Archive map to a server status; the rest are
// resolved client-side (Starred/Sent/Trash/All) or local-only (Drafts).
type Folder =
  | "inbox"
  | "starred"
  | "sent"
  | "archive"
  | "drafts"
  | "trash"
  | "all"
  // Auto-sent system notices (outbox_emails) — DO dispatch / Invoice / CN / PO /
  // invite emails the system fires from noreply@. Distinct from "sent" (which is
  // human mailbox replies). Rendered by its own OutboxPanel, not the thread list.
  | "autosent";

// Department ordering for the sidebar: priority depts first, then A–Z, with
// the catch-all bucket pinned last.
const DEPT_PRIORITY = ["Support", "Finance", "HR"];
const UNASSIGNED_DEPT = "Other";

// Canonical SHARED department mailboxes (owner 2026-06-17 — "I can't see
// support@/finance@/hr@"). These ALWAYS appear in the Departments section even
// before anyone creates the address row, so the owner sees them; a SUPER_ADMIN
// gets a one-click "Set up" that provisions the row (assignedDept set, no user)
// via the existing POST /addresses. Until inbound RECEIVE is live (MX cutover,
// #51) they correctly show an empty thread list — that's expected, not a bug.
const CANONICAL_DEPT_MAILBOXES: { dept: string; address: string }[] = [
  { dept: "Support", address: "support@hookka.com" },
  { dept: "Finance", address: "finance@hookka.com" },
  { dept: "HR", address: "hr@hookka.com" },
];

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

// Subscribe to the persisted view preferences (density / reading-pane /
// category-tabs). Cross-tab synced via the storage event in mail-prefs.ts.
function useMailPrefs(): MailViewPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefsSnapshot, getPrefsSnapshot);
}

// Strip HTML + entities out of a snippet so the preview reads as clean text,
// not raw source like "<!DOCTYPE H…" (owner 2026-06-18). Shared by both
// densities.
function cleanSnippet(s: string): string {
  return (
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, " ")
      .replace(/\s+/g, " ")
      .trim() || "(no preview)"
  );
}

// ---------------------------------------------------------------------------
// ThreadList — the thread rows. Two densities:
//   • compact     — a Gmail-style SINGLE-LINE row: [checkbox][star][unread dot]
//                   Sender (bold when unread) · Subject — snippet (muted,
//                   truncated) ……… date (right), with hover row actions.
//   • comfortable — the original taller multi-line card (sender + subject +
//                   snippet + label chips stacked), preserved verbatim.
// Both share the same checkbox / star / hover-action behaviour.
// ---------------------------------------------------------------------------
function ThreadList({
  threads,
  loading,
  activeId,
  folder,
  density,
  selectedIds,
  colorMap,
  onToggleSelect,
  onOpen,
  onInjectTest,
  onRowAction,
  listKey,
  isSuperAdmin,
}: {
  threads: MailThread[];
  loading: boolean;
  activeId: string | null;
  folder: Folder;
  density: MailDensity;
  selectedIds: Set<string>;
  colorMap: Map<string, string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onInjectTest: () => void;
  onRowAction: (action: RowAction, t: MailThread) => void;
  /** Gates the test-inject affordance — POST /test-inject is admin-only, so
   *  offering the button to anyone else only produces a 403. */
  isSuperAdmin: boolean;
  /** Identifies the current list (folder + mailbox + search) — changing it
   *  rewinds the rendered slice to the first screenful. */
  listKey: string;
}) {
  // The threads endpoint caps at 300 and the list used to render every one of
  // them: 11,543 DOM nodes and a 3,745ms main-thread freeze on open, measured
  // on prod 2026-08-01, while its APIs answered in 350ms. Render the newest
  // screenfuls and extend as the reader scrolls — nobody opens Mail Center to
  // read thread #300, and the ones who scroll that far land exactly where they
  // used to, just later.
  const { count, hasMore, sentinelRef } = useIncrementalList({
    total: threads.length,
    initial: 40,
    step: 40,
    resetKey: listKey,
  });

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
            {/* Inbound mail has been live since the MX cutover — prod was
                receiving on 2026-08-19. The old copy here still told every
                reader that receiving was not switched on yet, so an empty
                mailbox read as a broken system rather than as an empty
                mailbox. Say the true thing instead (owner 2026-08-19). */}
            <p className="max-w-xs text-[11px] leading-snug text-muted-foreground/70">
              Nothing has arrived in this mailbox yet.
            </p>
            {/* Admin-only: POST /test-inject is requireSuperAdmin, so this
                button could only ever have produced a 403 for anyone else. */}
            {isSuperAdmin && (
              <button
                onClick={onInjectTest}
                className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
              >
                Inject a test email (verify inbox)
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  const compact = density === "compact";
  return (
    <>
    <ul className="divide-y divide-border">
      {threads.slice(0, count).map((t) =>
        compact ? (
          <CompactRow
            key={t.id}
            t={t}
            active={activeId === t.id}
            folder={folder}
            selected={selectedIds.has(t.id)}
            colorMap={colorMap}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            onRowAction={onRowAction}
          />
        ) : (
          <ComfortableRow
            key={t.id}
            t={t}
            active={activeId === t.id}
            folder={folder}
            selected={selectedIds.has(t.id)}
            colorMap={colorMap}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            onRowAction={onRowAction}
          />
        ),
      )}
    </ul>
    {hasMore && (
      <div
        ref={sentinelRef}
        className="px-4 py-3 text-center text-xs text-muted-foreground"
      >
        Loading older conversations… ({count} of {threads.length})
      </div>
    )}
    </>
  );
}

type RowProps = {
  t: MailThread;
  active: boolean;
  folder: Folder;
  selected: boolean;
  colorMap: Map<string, string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRowAction: (action: RowAction, t: MailThread) => void;
};

// Shared leading controls (select checkbox + star) — identical in both
// densities, so the two row layouts can't drift on the bulk-select / star
// behaviour.
function RowLead({
  t,
  selected,
  onToggleSelect,
  onRowAction,
}: Pick<RowProps, "t" | "selected" | "onToggleSelect" | "onRowAction">) {
  const starred = t.starred;
  return (
    <>
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
          className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-500")}
        />
      </button>
    </>
  );
}

// Shared hover action cluster (read/unread · archive/inbox · trash/restore).
function RowActions({
  t,
  folder,
  onRowAction,
}: Pick<RowProps, "t" | "folder" | "onRowAction">) {
  const unread = t.unread;
  return (
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
  );
}

// ── Compact (Gmail single-line) row ─────────────────────────────────────────
// One tight line: sender (bold when unread) · subject — snippet (muted) … date.
// Labels render as small dots inline; the mailbox/Archived chip is dropped to
// keep the line clean (still shown in comfortable + the reading pane). The date
// is replaced by the hover action cluster on hover (Gmail behaviour).
function CompactRow({
  t,
  active,
  folder,
  selected,
  colorMap,
  onToggleSelect,
  onOpen,
  onRowAction,
}: RowProps) {
  const unread = t.unread;
  const chips = t.labels;
  return (
    <li
      className={cn(
        "group relative flex items-center border-l-2 transition",
        active
          ? "border-amber-500 bg-amber-50/70"
          : selected
            ? "border-amber-400 bg-amber-50/40"
            : unread
              ? "border-amber-400 bg-amber-50/40"
              : "border-transparent hover:bg-muted/50",
      )}
    >
      <RowLead
        t={t}
        selected={selected}
        onToggleSelect={onToggleSelect}
        onRowAction={onRowAction}
      />
      {/* Unread dot column (kept tiny). */}
      <span className="flex w-3 shrink-0 items-center justify-center">
        {unread && (
          <span
            className="h-2 w-2 rounded-full bg-amber-500"
            aria-hidden="true"
          />
        )}
      </span>
      <button
        onClick={() => onOpen(t.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-2 text-left"
      >
        {/* Sender — fixed-ish width, bold when unread. */}
        <span
          className={cn(
            "w-32 shrink-0 truncate text-sm sm:w-40",
            unread
              ? "font-semibold text-foreground"
              : "font-medium text-foreground/80",
          )}
        >
          {senderLabel(t)}
        </span>
        {/* Label dots (compact) — just the coloured dots inline before the
            subject, so categories stay visible without eating the line. */}
        {chips.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            {chips.slice(0, 3).map((l) => (
              <span
                key={l}
                title={l}
                className="h-2 w-2 rounded-full ring-1 ring-inset ring-black/10"
                style={{ backgroundColor: colorForLabel(l, colorMap) }}
                aria-hidden="true"
              />
            ))}
          </span>
        )}
        {/* Subject — snippet on one line. */}
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className={cn(unread ? "text-foreground" : "text-foreground/70")}>
            {t.subject || "(no subject)"}
          </span>
          {t.messageCount > 1 && (
            <span className="text-muted-foreground"> ({t.messageCount})</span>
          )}
          {t.lastSnippet && (
            <span className="text-muted-foreground/70">
              {" — "}
              {cleanSnippet(t.lastSnippet)}
            </span>
          )}
        </span>
      </button>
      {/* Date — hidden on hover so the action cluster takes its place. */}
      <span className="shrink-0 px-2 text-xs text-muted-foreground group-hover:hidden group-focus-within:hidden">
        {fmtTime(t.lastMessageAt)}
      </span>
      <div className="hidden group-hover:flex group-focus-within:flex">
        <RowActions t={t} folder={folder} onRowAction={onRowAction} />
      </div>
    </li>
  );
}

// ── Comfortable (original multi-line card) row ──────────────────────────────
// Preserved verbatim from the previous layout so "comfortable" density gives
// the owner back the old look exactly.
function ComfortableRow({
  t,
  active,
  folder,
  selected,
  colorMap,
  onToggleSelect,
  onOpen,
  onRowAction,
}: RowProps) {
  const unread = t.unread;
  const chips = t.labels;
  return (
    <li
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
      <RowLead
        t={t}
        selected={selected}
        onToggleSelect={onToggleSelect}
        onRowAction={onRowAction}
      />

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
              {cleanSnippet(t.lastSnippet)}
            </p>
          )}
          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {chips.map((l) => {
                const color = colorForLabel(l, colorMap);
                return (
                  <span
                    key={l}
                    style={chipStyle(color)}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-black/5"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    {l}
                  </span>
                );
              })}
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

      <RowActions t={t} folder={folder} onRowAction={onRowAction} />
    </li>
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
  const prefs = useMailPrefs();
  // Split = list + reading pane (the 3-pane behaviour); Full = full-width list,
  // a row opens the standalone detail route. On a narrow screen the reading
  // pane can't fit, so we always behave as "full" there regardless of the pref.
  const splitView = prefs.readingPane === "split";
  // Gmail category tab over the already-fetched rows (client-side only).
  const [category, setCategory] = useState<MailCategory>("all");
  // SUPER_ADMIN sees every mailbox (the backend scope returns all) AND gets the
  // one-click "Set up" for a missing canonical department mailbox.
  const isSuperAdmin =
    (getCurrentUser()?.role ?? "").toUpperCase() === "SUPER_ADMIN";

  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [filter, setFilter] = useState<MailboxFilter>({ kind: "all" });
  const [composeOpen, setComposeOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<MailDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Label manager dialog (create / rename / recolour / delete catalogue labels).
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);

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
  // Label catalogue (name → colour). Drives the coloured dots in the sidebar +
  // thread-list chips and the label menus. Short TTL so a create/recolour shows
  // promptly; the mutation helpers also invalidate this prefix.
  const { data: labelCatalog } = useCachedJson<MailLabel[]>(
    "/api/mail-center/labels",
    60,
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

  // DEPARTMENT vs PERSONAL split (owner 2026-06-17). The Mailboxes sidebar now
  // shows a "Departments" section and a separate "Other" (personal) section so
  // shared mailboxes are never lost among personal aliases:
  //   • departmentGroups — every real department (≠ "Other"), MERGED with the
  //     canonical Support/Finance/HR so they ALWAYS appear even when no address
  //     row exists yet. A canonical dept with no row carries a synthetic
  //     placeholder entry (a missing shared mailbox) the admin can one-click set
  //     up. This is why the owner couldn't see support@/finance@/hr@: they were
  //     never created as rows, so the address-driven list had nothing to show.
  //   • personalGroup — the "Other" bucket (active aliases with no department,
  //     e.g. lim@ / violet@), shown under its own "Other" header.
  const departmentGroups = useMemo(() => {
    // Real department buckets keyed by dept name (excludes the personal "Other").
    const real = new Map<string, MailAddress[]>();
    for (const g of deptGroups) {
      if (g.dept === UNASSIGNED_DEPT) continue;
      real.set(g.dept, g.mailboxes);
    }
    // Ensure every canonical department is present even with zero mailboxes —
    // but ONLY for a SUPER_ADMIN, who is the only person who can act on the
    // result (the "Set up" button is admin-gated).
    //
    // For everyone else this injection was actively misleading (owner
    // 2026-08-19). GET /addresses is scoped by mail_user_scope, so a Sales user
    // is returned only their own mailbox — support@/finance@/hr@ come back
    // absent because they are NOT VISIBLE TO THEM, not because they don't
    // exist. The sidebar then labelled all three "not set up", telling a
    // salesperson that Finance has no mailbox while finance@hookka.com in fact
    // held 1,039 threads. It also disclosed the addresses themselves.
    //
    // The rule: the sidebar shows what the backend actually returned, and
    // nothing else.
    const deptNames = new Set<string>(real.keys());
    if (isSuperAdmin) {
      for (const c of CANONICAL_DEPT_MAILBOXES) deptNames.add(c.dept);
    }

    const groups: { dept: string; entries: MailboxEntry[] }[] = [];
    for (const dept of Array.from(deptNames).sort(sortDepts)) {
      const existing = real.get(dept) ?? [];
      const haveAddrs = new Set(existing.map((a) => a.address.toLowerCase()));
      const entries: MailboxEntry[] = existing.map((address) => ({
        kind: "real",
        address,
      }));
      // Add any canonical shared mailbox for this dept that has no row yet.
      // Admin-only for the same reason as above: to a non-admin, "missing"
      // is indistinguishable from "not yours to see".
      if (isSuperAdmin) {
        for (const c of CANONICAL_DEPT_MAILBOXES) {
          if (c.dept === dept && !haveAddrs.has(c.address.toLowerCase())) {
            entries.push({ kind: "missing", address: c.address, dept });
          }
        }
      }
      groups.push({ dept, entries });
    }
    return groups;
  }, [deptGroups, isSuperAdmin]);

  // The personal "Other" bucket (aliases with no department).
  const personalMailboxes = useMemo(() => {
    const other = deptGroups.find((g) => g.dept === UNASSIGNED_DEPT);
    return other?.mailboxes ?? [];
  }, [deptGroups]);

  // Client-side narrowing of the already-scoped list. Trash and status are now
  // resolved server-side (the fetched set is already the right folder), so this
  // only layers on:
  //   1. Folder semantics — Starred (DB star) / Sent (hasOutbound) on top of
  //      the server status the list was fetched with.
  //   2. Department filter — when a whole dept is selected.
  //   3. Label filter — when a sidebar label is active (DB labels).
  //   4. Text search over subject / sender name / sender email / snippet.
  // The Gmail CATEGORY tab (Primary/Notifications) is applied separately on top
  // of this (see `visible` below) so each tab can show its own count.
  const categoryBase = useMemo(() => {
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

  // Category-tab counts (Primary / Notifications) — computed over the
  // folder/dept/label/search-narrowed set BEFORE the category filter, so each
  // tab shows its own total. Client-side heuristic over the counterparty email;
  // never touches the backend.
  const categoryCounts = useMemo(() => {
    let primary = 0;
    let notifications = 0;
    for (const t of categoryBase) {
      if (classifyCategory(t.counterpartyEmail) === "notifications") notifications++;
      else primary++;
    }
    return { all: categoryBase.length, primary, notifications };
  }, [categoryBase]);

  // The list actually shown: the category-narrowed set when the tabs are on and
  // a specific tab (not "All") is active; otherwise the full narrowed set.
  const visible = useMemo(() => {
    if (!prefs.categoryTabs || category === "all") return categoryBase;
    return categoryBase.filter(
      (t) => classifyCategory(t.counterpartyEmail) === category,
    );
  }, [categoryBase, category, prefs.categoryTabs]);

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

  // Catalogue colour lookup (name → colour), shared by the sidebar dots and the
  // thread-list chips.
  const colorMap = useMemo(
    () => labelColorMap(labelCatalog ?? []),
    [labelCatalog],
  );

  // Sidebar label list = the CATALOGUE (so a freshly created label shows even
  // before it's applied to any thread) UNIONED with any label name found on a
  // loaded thread but missing from the catalogue (legacy free-text labels keep
  // working). Each entry carries its resolved colour for the dot.
  const labels = useMemo(() => {
    const names = new Map<string, string>(); // lowerName → displayName
    for (const l of labelCatalog ?? []) names.set(l.name.toLowerCase(), l.name);
    for (const t of liveThreads) {
      for (const l of t.labels) {
        if (!names.has(l.toLowerCase())) names.set(l.toLowerCase(), l);
      }
    }
    return Array.from(names.values())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, color: colorForLabel(name, colorMap) }));
  }, [labelCatalog, liveThreads, colorMap]);
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
    //
    // Reading pane on (split) + a desktop-wide screen → open in the right pane.
    // Otherwise (full-width-list pref, or a narrow screen where the pane can't
    // fit) → navigate to the standalone /mail-center/:id detail route.
    if (isDesktop && splitView) {
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

  // Bulk-apply ONE label to the selection. Ensures the catalogue carries the
  // name (so it gets a colour + shows in the sidebar), then merges it into each
  // selected thread's label set. `name` comes from the catalogue or is typed new.
  async function bulkApplyLabel(name: string) {
    const clean = name.trim();
    if (!clean) return;
    const items = selectedArr.map((t) => ({ id: t.id, labels: t.labels }));
    if (items.length === 0) return;
    // Create the catalogue entry if it's brand new (idempotent server-side).
    if (!colorMap.has(clean.toLowerCase())) {
      await createLabel(clean, LABEL_PALETTE[0].value);
    }
    const ok = await patchManyAddLabel(items, clean);
    if (ok === items.length) toast.success(`Labeled ${ok} as “${clean}”.`);
    else if (ok > 0) toast.warning(`Labeled ${ok} of ${items.length}.`);
    else toast.error("Couldn’t label. Please try again.");
    clearSelection();
  }

  async function injectTest() {
    try {
      await fetch("/api/mail-center/test-inject", {
        method: "POST",
        headers: csrfHeaders(),
        credentials: "include",
      });
    } catch {
      /* ignore — refresh just shows nothing changed */
    }
    refresh();
  }

  // SUPER_ADMIN: provision a missing canonical department mailbox (support@/
  // finance@/hr@) as a SHARED address (assignedDept set, no user). Confirmed
  // first ("no naked edits"), then created via the existing POST /addresses.
  async function setupDeptMailbox(address: string, dept: string) {
    const confirmed = await confirm({
      title: `Set up ${address}?`,
      message: `Creates the shared ${dept} mailbox so the team can receive and reply from it. You can grant people access in User Management → Mailbox Access.`,
      confirmLabel: "Set up mailbox",
    });
    if (!confirmed) return;
    const id = await createDeptMailbox(address, dept, `${dept} Team`);
    if (id !== null) {
      toast.success(`${address} is ready.`);
      setFilter({ kind: "mailbox", value: address });
    } else {
      toast.error("Couldn’t set up the mailbox. Please try again.");
    }
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
        <div className="flex items-center gap-2">
          <ViewSettingsMenu prefs={prefs} />
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            className="gap-1.5"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {/* Search — at the TOP (Gmail-style). Was previously buried at the bottom
          of the left rail, below the whole folder list, so you had to scroll
          past everything to reach it. */}
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search mail…"
          className="pl-8"
        />
      </div>

      {/* Shell: rail / list / (optional) reading-pane. In SPLIT mode (default)
          the lg grid is 3 columns — folders rail, a fixed-ish list column
          ~360-400px, then a flex-1 reading pane (Gmail/Outlook proportions). In
          FULL mode the reading pane is dropped and the list spans the rest of
          the width (rail + list only). Single column under md either way. */}
      <div
        className={cn(
          "grid grid-cols-1 gap-4 md:grid-cols-[210px_minmax(0,1fr)]",
          splitView &&
            "lg:grid-cols-[230px_minmax(360px,400px)_minmax(0,1fr)]",
        )}
      >
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
              icon={Bell}
              label="Auto-sent"
              active={folder === "autosent"}
              onClick={() => {
                setFolder("autosent");
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

          {/* LABELS — DB-backed categories with Gmail-style coloured dots.
              Selecting one filters the list; "Manage" opens the editor to
              create / rename / recolour / delete catalogue labels. */}
          <div className="space-y-0.5">
            <div className="flex items-center justify-between px-3 pb-0.5 pt-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Labels
              </p>
              <button
                type="button"
                onClick={() => setLabelManagerOpen(true)}
                title="Manage labels"
                aria-label="Manage labels"
                className="rounded p-0.5 text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {labels.length === 0 ? (
              <button
                type="button"
                onClick={() => setLabelManagerOpen(true)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground/70 transition hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Create a label</span>
              </button>
            ) : (
              labels.map((l) => (
                <button
                  key={l.name}
                  onClick={() =>
                    setLabelFilter(labelFilter === l.name ? null : l.name)
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition",
                    labelFilter === l.name
                      ? "bg-amber-50 font-medium text-amber-800"
                      : "text-foreground/80 hover:bg-muted",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                    style={{ backgroundColor: l.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{l.name}</span>
                </button>
              ))
            )}
          </div>

          {/* MAILBOX SWITCHER — All mailboxes, then a DEPARTMENTS section
              (shared support@/finance@/hr@ etc., always shown) and a separate
              OTHER section for personal aliases. */}
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

            {/* DEPARTMENTS — shared department mailboxes. Canonical
                Support/Finance/HR always appear; a missing one offers a "Set
                up" (SUPER_ADMIN) or a quiet "not set up yet" note. */}
            <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              <Building2 className="h-3 w-3" />
              Departments
            </p>
            {departmentGroups.map((g) => (
              <DeptGroup
                key={g.dept}
                dept={g.dept}
                entries={g.entries}
                filter={filter}
                isSuperAdmin={isSuperAdmin}
                unreadByMailbox={unreadByMailbox}
                unreadForDept={unreadByDept.get(g.dept) ?? 0}
                onSelectDept={() => setFilter({ kind: "dept", value: g.dept })}
                onSelectMailbox={(address) =>
                  setFilter({ kind: "mailbox", value: address })
                }
                onSetupMailbox={setupDeptMailbox}
              />
            ))}

            {/* OTHER — personal aliases with no department (e.g. lim@/violet@). */}
            {personalMailboxes.length > 0 && (
              <>
                <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                  <UserIcon className="h-3 w-3" />
                  Other
                </p>
                <div className="space-y-0.5">
                  {personalMailboxes.map((a) => (
                    <PersonItem
                      key={a.id}
                      label={a.assignedUserName || a.address}
                      title={a.address}
                      active={
                        filter.kind === "mailbox" && filter.value === a.address
                      }
                      unread={unreadByMailbox.get(a.address) ?? 0}
                      onClick={() =>
                        setFilter({ kind: "mailbox", value: a.address })
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* MIDDLE+RIGHT — "Auto-sent" renders the outbox panel across the
            content area; every other folder keeps the thread list (+ the split
            reading pane). The left rail stays mounted either way. */}
        {folder === "autosent" ? (
          // Sits in the content column exactly like the thread list. Only span
          // cols 2-3 when the 3-col SPLIT grid is active; in the 2-col grid a
          // col-span-2 has no col 3 to land in and wraps the panel to a new row
          // (full-width, stuck at the bottom) — the bug Wei Siang spotted.
          <div className={cn("min-w-0", splitView && "lg:col-span-2")}>
            <OutboxPanel />
          </div>
        ) : (
          <>
        {/* MIDDLE — thread list (or drafts list) */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {/* Gmail-style category tabs (All / Primary / Notifications) —
                client-side split of the inbox by sender. Shown only when the
                "category tabs" view toggle is on and we're not in Drafts (which
                are local compose drafts, not inbound mail to categorise). */}
            {prefs.categoryTabs && folder !== "drafts" && (
              <CategoryTabs
                active={category}
                counts={categoryCounts}
                onSelect={setCategory}
              />
            )}

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
                labels={labels}
                onArchive={() => bulkStatus("closed")}
                onInbox={() => bulkStatus("open")}
                onRead={() => bulkRead(false)}
                onUnread={() => bulkRead(true)}
                onTrash={bulkTrash}
                onApplyLabel={bulkApplyLabel}
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
                activeId={isDesktop && splitView ? selectedId : null}
                folder={folder}
                density={prefs.density}
                selectedIds={selectedVisibleIds}
                colorMap={colorMap}
                onToggleSelect={toggleSelect}
                onOpen={openThread}
                onInjectTest={injectTest}
                onRowAction={onRowAction}
                isSuperAdmin={isSuperAdmin}
                listKey={`${folder}|${filter.kind}|${filter.kind === "mailbox" ? filter.value : ""}|${q}`}
              />
            )}
          </CardContent>
        </Card>

        {/* RIGHT — reading pane (lg+ only, SPLIT mode only). When a thread is
            selected it shows the conversation in a card; when nothing is
            selected it's a simple borderless, centered placeholder (no card, no
            compose button — the sidebar "New email" is the single compose
            entry, Gmail/Outlook style). In FULL mode this column is dropped and
            a row opens the standalone detail route instead. */}
        {splitView && (
          <div className="hidden min-w-0 lg:block">
            {selectedId ? (
              <Card className="min-w-0">
                <CardContent className="p-4">
                  <MailCenterDetailPage
                    key={selectedId}
                    id={selectedId}
                    embedded
                  />
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
        )}
          </>
        )}
      </div>

      {/* Label manager — create / rename / recolour / delete catalogue labels. */}
      <LabelManagerDialog
        open={labelManagerOpen}
        labels={labelCatalog ?? []}
        onClose={() => setLabelManagerOpen(false)}
      />

      {/* Compose modal — additive overlay; closing returns to the inbox. */}
      <ComposeDialog
        open={composeOpen}
        initialDraft={resumeDraft}
        onClose={() => {
          setComposeOpen(false);
          setResumeDraft(null);
        }}
        onSent={(threadId) => {
          // Show the just-sent thread in the reading pane (split mode only;
          // there's no pane in full mode).
          if (isDesktop && splitView) setSelectedId(threadId);
        }}
      />

      {confirmDialog}
    </div>
  );
}

// ── Auto-sent panel (outbox_emails) ──────────────────────────────────────────
// Read-only view of the system's auto-sent customer notices (Delivery Order
// dispatched, Invoice, CN, PO, invites) — the emails that go out from noreply@
// so there is no human "Sent" copy to read. Owner 2026-06-24: "因為是 noreply
// 所以看到不到". Lists the org's sent log newest-first with a per-row status, and
// opens the full body (+ recipient / time / failure reason / attachment names)
// in a modal. Data: GET /api/mail-center/outbox  (+ /outbox/:id for the body).
type OutboxItem = {
  id: string;
  toAddress: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
  snippet: string;
  attachmentNames: string[];
};
type OutboxCounts = { sent: number; failed: number; pending: number };

function outboxStatusTone(status: string): string {
  switch (status.toUpperCase()) {
    case "SENT":
      return "bg-green-100 text-green-800";
    case "FAILED":
      return "bg-red-100 text-red-800";
    default:
      return "bg-amber-100 text-amber-800"; // PENDING / RETRYING / SENDING
  }
}

function outboxStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "SENT":
      return "Sent";
    case "FAILED":
      return "Failed";
    case "SENDING":
      return "Sending";
    case "RETRYING":
      return "Retrying";
    default:
      return "Pending";
  }
}

function fmtMailTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString();
}

function OutboxPanel() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [counts, setCounts] = useState<OutboxCounts>({
    sent: 0,
    failed: 0,
    pending: 0,
  });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);
  // The auto-sent email opened in the full detail view (replaces the old
  // centered modal). null = show the list. When set, the content area renders
  // OutboxDetailView in place of the list, mirroring the inbox split-vs-full
  // detail chrome so an auto-sent notice opens the SAME way a normal mail does.
  const [selectedOutboxId, setSelectedOutboxId] = useState<string | null>(null);

  useEffect(() => {
    // NB: no synchronous setState in the effect body (react-hooks/
    // set-state-in-effect). `loading` starts true for the first load; reloads
    // flip it true in the trigger handlers (filter chip / refresh button).
    let alive = true;
    (async () => {
      try {
        const qs = statusFilter
          ? `?status=${encodeURIComponent(statusFilter)}`
          : "";
        const res = await fetch(`/api/mail-center/outbox${qs}`);
        const j = (await res.json().catch(() => null)) as {
          rows?: OutboxItem[];
          counts?: OutboxCounts;
        } | null;
        if (!alive) return;
        if (!res.ok || !j) {
          setErr("Couldn’t load sent emails.");
          setItems([]);
        } else {
          setErr(null);
          setItems(Array.isArray(j.rows) ? j.rows : []);
          if (j.counts) setCounts(j.counts);
        }
      } catch {
        if (alive) {
          setErr("Couldn’t load sent emails — network error.");
          setItems([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [statusFilter, reloadKey]);

  const filters: { v: string; l: string }[] = [
    { v: "", l: "All" },
    { v: "SENT", l: "Sent" },
    { v: "FAILED", l: "Failed" },
    { v: "PENDING", l: "Pending" },
  ];

  // Detail view — same full-page detail chrome as a normal mail (back button,
  // subject header, message card, toolbar styling). Replaces the old modal.
  if (selectedOutboxId) {
    return (
      <OutboxDetailView
        key={selectedOutboxId}
        id={selectedOutboxId}
        onBack={() => setSelectedOutboxId(null)}
      />
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Toolbar — same single-line density as the normal mail list
            toolbar (bg-muted/30 · px-3 py-1.5): title on the left, status
            roll-up + count + refresh on the right. */}
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Bell className="h-3.5 w-3.5 text-amber-700" />
            <span className="font-medium text-foreground/80">
              Auto-sent emails
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="rounded-full bg-green-100 px-2 py-0.5 font-semibold text-green-800">
              {counts.sent} sent
            </span>
            {counts.failed > 0 && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-800">
                {counts.failed} failed
              </span>
            )}
            {counts.pending > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                {counts.pending} pending
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setReloadKey((k) => k + 1);
              }}
              className="ml-1 rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
          {filters.map((f) => (
            <button
              key={f.v || "all"}
              type="button"
              onClick={() => {
                if (statusFilter === f.v) return;
                setLoading(true);
                setStatusFilter(f.v);
              }}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition",
                statusFilter === f.v
                  ? "bg-amber-100 text-amber-800"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {f.l}
            </button>
          ))}
        </div>

        {err && <div className="px-3 py-2 text-sm text-red-700">{err}</div>}

        {loading && items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
            <Bell className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No auto-sent emails {statusFilter ? "in this filter" : "yet"}.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => (
              <li
                key={it.id}
                className="group relative flex items-center border-l-2 border-transparent transition hover:bg-muted/50"
              >
                {/* Status chip column — stands in for the select/star lead of
                    the normal list; keeps the outbox-specific
                    Sent/Failed/Pending state visible without breaking the row
                    rhythm. */}
                <span className="flex shrink-0 items-center pl-3 pr-1">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      outboxStatusTone(it.status),
                    )}
                  >
                    {outboxStatusLabel(it.status)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedOutboxId(it.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 pr-2 text-left"
                >
                  {/* Recipient — fixed-ish width + bold, matches CompactRow
                      sender. */}
                  <span className="w-32 shrink-0 truncate text-sm font-medium text-foreground/80 sm:w-40">
                    {it.toAddress || "(no recipient)"}
                  </span>
                  {/* Subject (+ attachment count / failure note) on one line. */}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="text-foreground/70">{it.subject}</span>
                    {it.attachmentNames.length > 0 && (
                      <span className="text-muted-foreground/70">
                        {" · "}
                        {it.attachmentNames.length} attachment
                        {it.attachmentNames.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {it.status === "FAILED" && it.lastError && (
                      <span className="text-red-700"> — {it.lastError}</span>
                    )}
                  </span>
                </button>
                {/* Date — right-aligned, same treatment as CompactRow. */}
                <span className="shrink-0 px-2 text-xs text-muted-foreground">
                  {fmtMailTime(it.sentAt || it.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type OutboxDetail = {
  toAddress: string;
  subject: string;
  status: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
  bodyText: string;
  bodyHtml: string;
  attachmentNames: string[];
};

// Inject the same base styles the inbox detail uses so an auto-sent email body
// renders identically to a normal mail body (mirrors detail.tsx's emailSrcDoc:
// `<base target=_blank>` for links, a readable system-ui body, responsive imgs).
function outboxEmailSrcDoc(rawHtml: string): string {
  const inject = `<base target="_blank"><meta charset="utf-8"><style>html,body{margin:0;padding:10px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#1f1d1b;word-break:break-word;overflow-x:hidden}img{max-width:100%;height:auto}table{max-width:100%}</style>`;
  if (/<head[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(rawHtml))
    return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rawHtml}</body></html>`;
}

// Full-detail view for an auto-sent (outbox) email. Same chrome as a normal
// inbox mail (MailCenterDetailPage): a "Back to inbox" button + a read-only
// toolbar bar on top, the subject header with a status/sent metadata line, then
// the email rendered in the SAME bordered message card (avatar + from/to header
// + sandboxed-iframe body). Auto-sent notices are OUTBOUND system emails with
// no reply thread, so this is read-only — no reply box, no star/label/assign —
// but it is laid out and typed identically so the two open the same way. Data
// still comes from GET /api/mail-center/outbox/:id (same source as the old
// modal); only the presentation changed.
function OutboxDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<OutboxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // No synchronous setState in the effect body (react-hooks/
    // set-state-in-effect); `loading` starts true and the view mounts once per
    // id (keyed), so the fetch just flips it false when done.
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/mail-center/outbox/${encodeURIComponent(id)}`,
        );
        const j = (await res.json().catch(() => null)) as
          | (OutboxDetail & { error?: string })
          | null;
        if (!alive) return;
        if (res.ok && j && !j.error) setData(j);
        else setError("Couldn’t load this email.");
      } catch {
        if (alive) setError("Couldn’t load this email — network error.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Render the body the same way the inbox detail does: prefer the HTML part,
  // fall back to a HTML-looking text part, else plain text in a <pre>.
  const rawHtml =
    data?.bodyHtml?.trim() ||
    (looksLikeOutboxHtml(data?.bodyText) ? (data?.bodyText || "").trim() : "");
  const plain = rawHtml ? "" : data?.bodyText?.trim() || "";
  // Auto-sent system mail goes out from noreply@ — the "sender" in the card.
  const senderName = "Hookka";
  const initial = "H";

  return (
    <div className="space-y-4">
      {/* Top bar — "Back to inbox" + a read-only toolbar, matching the inbox
          detail header row. Auto-sent emails have no reply thread, so the
          toolbar shows only the read-only status (no Reply/Star/Trash actions). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to inbox
        </Button>
        {data && (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
              outboxStatusTone(data.status),
            )}
          >
            {outboxStatusLabel(data.status)}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      {!data && loading && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      )}

      {!data && !loading && !error && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Email not found.
        </p>
      )}

      {data && (
        <>
          {/* Subject header — same styling as the inbox detail subject block. */}
          <div className="space-y-2 border-b border-border pb-3">
            <h1 className="text-xl font-semibold leading-snug text-foreground">
              {data.subject || "(no subject)"}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                to{" "}
                <strong className="text-foreground/90">
                  {data.toAddress || "(no recipient)"}
                </strong>
              </span>
              <Badge className="text-[10px]">Auto-sent</Badge>
              {data.sentAt ? (
                <span>Sent {fmtMailTime(data.sentAt)}</span>
              ) : (
                <span>Queued {fmtMailTime(data.createdAt)}</span>
              )}
              {data.attempts > 0 && (
                <span>
                  · {data.attempts} attempt{data.attempts === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {data.status === "FAILED" && data.lastError && (
              <p className="rounded-md border border-red-100 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                Error: {data.lastError}
              </p>
            )}
          </div>

          {/* Message card — same layout as an inbound/outbound message in the
              inbox detail: brand avatar (it's from us), a from/to header line,
              the timestamp on the right, then the body in a sandboxed iframe
              (or a plain-text <pre> fallback), then the attachment names. */}
          <Card className="border-amber-200 bg-amber-50/40">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#6B5C32] text-sm font-semibold text-white">
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {senderName}
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        &lt;noreply@&gt;
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {fmtMailTime(data.sentAt || data.createdAt)}
                    </span>
                  </div>
                  {data.toAddress && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      To: {data.toAddress}
                    </p>
                  )}
                  {rawHtml ? (
                    <iframe
                      title="Email"
                      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                      srcDoc={outboxEmailSrcDoc(rawHtml)}
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

                  {/* Attachments — owner 2026-06-30: need to download what
                      was actually sent (customer complained the fallback PDF
                      was too plain). Each chip is now an <a> hitting
                      /api/mail-center/outbox/:id/attachments/:idx/download
                      which streams the base64 blob from outbox_emails.
                      attachments_json back as a binary file. */}
                  {data.attachmentNames.length > 0 && (
                    <div className="mt-3 border-t border-border/60 pt-2">
                      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Paperclip className="h-3 w-3" />
                        {data.attachmentNames.length} attachment
                        {data.attachmentNames.length === 1 ? "" : "s"}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {data.attachmentNames.map((name, i) => (
                          <a
                            key={`${name}-${i}`}
                            href={`/api/mail-center/outbox/${encodeURIComponent(
                              id,
                            )}/attachments/${i}/download`}
                            download={name}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground/90 hover:bg-muted/70 hover:text-foreground"
                            title={`Download ${name}`}
                          >
                            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{name}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// Whether a text body actually looks like HTML (e.g. some templates put a full
// HTML doc into the text part). Mirrors detail.tsx's looksLikeHtml.
function looksLikeOutboxHtml(s: string | undefined): boolean {
  return /<(?:!doctype|html|body|head|div|table|tr|td|p|br|span|a|img|style|font|center|ul|ol|li|h[1-6])[\s>/]/i.test(
    s || "",
  );
}

// ── Category tabs (Gmail Primary / Notifications) ────────────────────────────
// A client-side split of the inbox by sender (see classifyCategory). "All"
// clears the filter. Each tab carries its own count. Rendered as an underlined
// tab strip above the list — Gmail's category-row idiom, restyled to the app's
// warm palette.
function CategoryTabs({
  active,
  counts,
  onSelect,
}: {
  active: MailCategory;
  counts: { all: number; primary: number; notifications: number };
  onSelect: (c: MailCategory) => void;
}) {
  const tabs: {
    id: MailCategory;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count: number;
  }[] = [
    { id: "all", label: "All", icon: Inbox, count: counts.all },
    { id: "primary", label: "Primary", icon: UserIcon, count: counts.primary },
    {
      id: "notifications",
      label: "Notifications",
      icon: Bell,
      count: counts.notifications,
    },
  ];
  return (
    <div className="flex items-stretch gap-0.5 border-b border-border bg-muted/20 px-1">
      {tabs.map((t) => {
        const on = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition",
              on
                ? "border-amber-600 text-amber-800"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            <span>{t.label}</span>
            {t.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  on ? "bg-amber-100 text-amber-800" : "bg-muted text-muted-foreground",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── View settings menu (the Gmail "settings" gear) ───────────────────────────
// One dropdown holding the three persisted view toggles — density,
// reading-pane and category-tabs. Each writes straight through to mail-prefs
// (localStorage); the page re-renders via the prefs external store. Closes on
// outside click / Escape.
function ViewSettingsMenu({ prefs }: { prefs: MailViewPrefs }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="View settings"
      >
        <SlidersHorizontal className="h-4 w-4" />
        View
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 rounded-md border border-[#E2DDD8] bg-white p-3 text-left shadow-lg"
        >
          {/* Density */}
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Density
          </p>
          <div className="mb-3 grid grid-cols-2 gap-1">
            <SegButton
              icon={Rows4}
              label="Compact"
              active={prefs.density === "compact"}
              onClick={() => setDensity("compact" satisfies MailDensity)}
            />
            <SegButton
              icon={Rows3}
              label="Comfortable"
              active={prefs.density === "comfortable"}
              onClick={() => setDensity("comfortable" satisfies MailDensity)}
            />
          </div>

          {/* Reading pane */}
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Reading pane
          </p>
          <div className="mb-3 grid grid-cols-2 gap-1">
            <SegButton
              icon={PanelRight}
              label="Split"
              active={prefs.readingPane === "split"}
              onClick={() => setReadingPane("split" satisfies MailReadingPane)}
            />
            <SegButton
              icon={Square}
              label="No split"
              active={prefs.readingPane === "full"}
              onClick={() => setReadingPane("full" satisfies MailReadingPane)}
            />
          </div>

          {/* Category tabs */}
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Category tabs
          </p>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.categoryTabs}
            onClick={() => setCategoryTabs(!prefs.categoryTabs)}
            className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground/80 transition hover:bg-muted"
          >
            <span className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground/60" />
              Show Primary / Notifications
            </span>
            <span
              className={cn(
                "flex h-4 w-7 items-center rounded-full px-0.5 transition",
                prefs.categoryTabs ? "bg-amber-500" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "h-3 w-3 rounded-full bg-white transition-transform",
                  prefs.categoryTabs && "translate-x-3",
                )}
              />
            </span>
          </button>
          <p className="mt-2 px-1 text-[10px] leading-snug text-muted-foreground/70">
            These choices are saved on this browser.
          </p>
        </div>
      )}
    </div>
  );
}

// A segmented-control button used inside the View settings menu.
function SegButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition",
        active
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-[#E2DDD8] bg-white text-foreground/70 hover:bg-muted",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
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
  labels,
  onArchive,
  onInbox,
  onRead,
  onUnread,
  onTrash,
  onApplyLabel,
  onClear,
}: {
  count: number;
  folder: Folder;
  labels: { name: string; color: string }[];
  onArchive: () => void;
  onInbox: () => void;
  onRead: () => void;
  onUnread: () => void;
  onTrash: () => void;
  onApplyLabel: (name: string) => void;
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
      <BulkLabelMenu labels={labels} onApplyLabel={onApplyLabel} />
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

// Bulk "Label" control — a small dropdown listing catalogue labels (with their
// colour dot) plus a free-text "New label…" row. Picking one applies it to the
// whole selection (creating the catalogue entry first if it's new). Closes on
// outside click / Escape.
function BulkLabelMenu({
  labels,
  onApplyLabel,
}: {
  labels: { name: string; color: string }[];
  onApplyLabel: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(name: string) {
    const clean = name.trim();
    if (!clean) return;
    onApplyLabel(clean);
    setDraft("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
      >
        <Tag className="h-3.5 w-3.5" />
        Label
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-[#E2DDD8] bg-white p-1 shadow-lg"
        >
          <div className="max-h-48 overflow-y-auto">
            {labels.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                No labels yet — type one below.
              </p>
            ) : (
              labels.map((l) => (
                <button
                  key={l.name}
                  type="button"
                  role="menuitem"
                  onClick={() => apply(l.name)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground/80 transition hover:bg-muted"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                    style={{ backgroundColor: l.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{l.name}</span>
                </button>
              ))
            )}
          </div>
          <div className="mt-1 flex items-center gap-1 border-t border-border/60 pt-1">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply(draft);
                }
              }}
              placeholder="New label…"
              className="h-7 flex-1 px-2 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!draft.trim()}
              onClick={() => apply(draft)}
            >
              Add
            </Button>
          </div>
        </div>
      )}
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
  entries,
  filter,
  isSuperAdmin,
  unreadByMailbox,
  unreadForDept,
  onSelectDept,
  onSelectMailbox,
  onSetupMailbox,
}: {
  dept: string;
  entries: MailboxEntry[];
  filter: MailboxFilter;
  isSuperAdmin: boolean;
  unreadByMailbox: Map<string, number>;
  unreadForDept: number;
  onSelectDept: () => void;
  onSelectMailbox: (address: string) => void;
  onSetupMailbox: (address: string, dept: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const deptActive = filter.kind === "dept" && filter.value === dept;
  // Count only REAL mailboxes for the badge; "missing" canonical entries are
  // placeholders, not live mailboxes.
  const realCount = entries.filter((e) => e.kind === "real").length;

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
              {realCount}
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
          {entries.map((e) => {
            if (e.kind === "missing") {
              return (
                <MissingMailboxItem
                  key={e.address}
                  address={e.address}
                  canSetup={isSuperAdmin}
                  onSetup={() => onSetupMailbox(e.address, e.dept)}
                />
              );
            }
            const a = e.address;
            const mailboxActive =
              filter.kind === "mailbox" && filter.value === a.address;
            // A shared mailbox (no assigned user) shows its address; a personal
            // alias misfiled into a dept shows the owner's name.
            const shared = !(a.assignedUserName ?? "").trim();
            return (
              <PersonItem
                key={a.id}
                label={a.assignedUserName || a.address}
                title={a.address}
                active={mailboxActive}
                shared={shared}
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

// A canonical shared mailbox that has no address row yet. For a SUPER_ADMIN it
// offers a one-click "Set up"; for everyone else it's a quiet, disabled note so
// they know the mailbox exists but isn't provisioned.
function MissingMailboxItem({
  address,
  canSetup,
  onSetup,
}: {
  address: string;
  canSetup: boolean;
  onSetup: () => void;
}) {
  if (!canSetup) {
    return (
      <div
        title={`${address} — not set up yet`}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground/50"
      >
        <Mail className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{address}</span>
        <span className="ml-auto shrink-0 text-[10px] italic">not set up</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onSetup}
      title={`Set up the shared mailbox ${address}`}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
    >
      <Mail className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{address}</span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#EFE9DD] px-1.5 py-0.5 text-[10px] font-medium text-[#6B5C32]">
        <Plus className="h-2.5 w-2.5" />
        Set up
      </span>
    </button>
  );
}

function PersonItem({
  label,
  title,
  active,
  unread,
  shared = false,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  unread: number;
  // A shared mailbox (no assigned user) gets the multi-user glyph; a personal
  // alias gets the single-user glyph. Defaults to personal.
  shared?: boolean;
  onClick: () => void;
}) {
  const Icon = shared ? Users : UserIcon;
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
        <Icon
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

// ── Label manager dialog ─────────────────────────────────────────────────────
// Gmail-style "Manage labels": a create row (name + colour swatches) and a list
// of existing catalogue labels, each editable inline (rename, recolour, delete).
// All mutations go through mail-actions (createLabel/updateLabel/deleteLabel),
// which invalidate the catalogue + thread caches so the sidebar/chips refresh.
// Rendered as a fixed overlay the house way (same shape as ComposeDialog).
function LabelManagerDialog({
  open,
  labels,
  onClose,
}: {
  open: boolean;
  labels: MailLabel[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_PALETTE[0].value);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function handleCreate() {
    const clean = newName.trim();
    if (!clean || busy) return;
    if (labels.some((l) => l.name.toLowerCase() === clean.toLowerCase())) {
      toast.error("A label with that name already exists.");
      return;
    }
    setBusy(true);
    try {
      const ok = await createLabel(clean, newColor);
      if (ok) {
        setNewName("");
        setNewColor(LABEL_PALETTE[0].value);
        toast.success("Label created.");
      } else {
        toast.error("Couldn’t create the label. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRecolor(id: string, color: string) {
    setBusy(true);
    try {
      const ok = await updateLabel(id, { color });
      if (!ok) toast.error("Couldn’t update the colour. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string, name: string, prev: string) {
    const clean = name.trim();
    if (!clean || clean === prev) return;
    if (
      labels.some(
        (l) => l.id !== id && l.name.toLowerCase() === clean.toLowerCase(),
      )
    ) {
      toast.error("A label with that name already exists.");
      return;
    }
    setBusy(true);
    try {
      const ok = await updateLabel(id, { name: clean });
      if (ok) toast.success("Label renamed.");
      else toast.error("Couldn’t rename the label. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    const confirmed = await confirm({
      title: `Delete “${name}”?`,
      message:
        "The label is removed from every conversation that carries it. This can’t be undone.",
      confirmLabel: "Delete label",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const ok = await deleteLabel(id);
      if (ok) toast.success("Label deleted.");
      else toast.error("Couldn’t delete the label. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage labels"
        className="relative mx-4 flex max-h-[90vh] w-full max-w-md flex-col rounded-lg border border-[#E2DDD8] bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-[#E2DDD8] px-4 py-3">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-[#1F1D1B]">
              Manage labels
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[#6B7280] transition hover:bg-[#F0ECE9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* Create row */}
          <div className="space-y-2 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-3">
            <label className="text-xs font-medium text-[#6B7280]">
              New label
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                placeholder="Label name"
                className="h-8 flex-1 text-sm"
              />
              <Button
                variant="primary"
                size="sm"
                className="h-8 gap-1 bg-[#6B5C32] px-2.5 text-white hover:bg-[#5a4d2a]"
                disabled={!newName.trim() || busy}
                onClick={handleCreate}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
            <ColorSwatches value={newColor} onPick={setNewColor} />
          </div>

          {/* Existing labels */}
          {labels.length === 0 ? (
            <p className="px-1 py-2 text-center text-xs text-muted-foreground">
              No labels yet. Create one above to colour-code conversations.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {labels
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((l) => (
                  <LabelManagerRow
                    key={`${l.id}:${l.name}`}
                    label={l}
                    busy={busy}
                    onRecolor={handleRecolor}
                    onRename={handleRename}
                    onDelete={handleDelete}
                  />
                ))}
            </ul>
          )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

// A row in the label manager: the colour dot + an inline-editable name, a colour
// picker popover, and a delete button.
function LabelManagerRow({
  label,
  busy,
  onRecolor,
  onRename,
  onDelete,
}: {
  label: MailLabel;
  busy: boolean;
  onRecolor: (id: string, color: string) => void;
  onRename: (id: string, name: string, prev: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  // Local editable draft of the name. The PARENT keys this row on id+name, so a
  // committed rename remounts the row with a fresh draft — no sync effect needed
  // (which would trip react-hooks/set-state-in-effect).
  const [name, setName] = useState(label.name);
  const [editingColor, setEditingColor] = useState(false);
  const color = label.color || LABEL_PALETTE[0].value;

  return (
    <li className="relative flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5">
      <button
        type="button"
        onClick={() => setEditingColor((v) => !v)}
        title="Change colour"
        aria-label="Change colour"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted"
      >
        <span
          className="h-3.5 w-3.5 rounded-full ring-1 ring-inset ring-black/10"
          style={{ backgroundColor: color }}
        />
      </button>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onRename(label.id, name, label.name)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        disabled={busy}
        className="h-7 flex-1 px-2 text-sm"
        aria-label={`Rename ${label.name}`}
      />
      <button
        type="button"
        onClick={() => onDelete(label.id, label.name)}
        disabled={busy}
        title="Delete label"
        aria-label={`Delete ${label.name}`}
        className="rounded p-1 text-muted-foreground/70 transition hover:bg-muted hover:text-red-600 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {editingColor && (
        <div className="absolute left-2 top-full z-10 mt-1 rounded-md border border-[#E2DDD8] bg-white p-2 shadow-lg">
          <ColorSwatches
            value={color}
            onPick={(c2) => {
              onRecolor(label.id, c2);
              setEditingColor(false);
            }}
          />
        </div>
      )}
    </li>
  );
}

// The shared colour-swatch row used by the create form and each label's colour
// popover. Renders the curated palette; the active swatch gets a ring.
function ColorSwatches({
  value,
  onPick,
}: {
  value: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {LABEL_PALETTE.map((c2) => {
        const active = c2.value.toUpperCase() === (value || "").toUpperCase();
        return (
          <button
            key={c2.value}
            type="button"
            onClick={() => onPick(c2.value)}
            title={c2.name}
            aria-label={c2.name}
            aria-pressed={active}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full ring-1 ring-inset ring-black/10 transition",
              active && "ring-2 ring-offset-1 ring-[#1F1D1B]",
            )}
            style={{ backgroundColor: c2.value }}
          >
            {active && <Check className="h-3.5 w-3.5 text-white" />}
          </button>
        );
      })}
    </div>
  );
}
