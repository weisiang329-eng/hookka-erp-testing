// ---------------------------------------------------------------------------
// Mail Center — client-side state for email-client features the BACKEND does
// not (yet) persist.
//
// The backend `email_threads` table only carries: status (open/closed),
// assigned_to_*, and an `unread` flag that is auto-cleared on open with NO
// PATCH to set it back. There is NO column for star/flag, NO label/category
// field, and NO delete / drafts / trash storage (see src/api/routes/
// mail-center.ts — PATCH /threads/:id accepts only status + assignedTo*).
//
// To still give operators the standard Gmail/Outlook affordances (star, label,
// trash, mark-unread, save-draft), this module keeps that state LOCALLY in
// localStorage, keyed per-thread, with a tiny pub/sub so the list, reading
// pane and sidebar counters stay in sync within and across tabs.
//
// GAP (reported to owner): because this is browser-local, these flags do NOT
// sync between users/devices and are lost if site data is cleared. Promoting
// any of them to a real shared feature needs a backend column + endpoint:
//   • star/flag   → email_threads.starred (INTEGER) + PATCH field
//   • labels      → email_threads.labels  (TEXT json) or a join table + PATCH
//   • trash       → email_threads.status='trashed' (or a deleted_at column)
//   • mark unread → a PATCH that can SET unread=1 (today it only clears on read)
//   • drafts      → an email_drafts table + CRUD endpoints
// ---------------------------------------------------------------------------

// Bump the version suffix if the persisted shape ever changes incompatibly.
const KEY = "hookka-mail-local:v1";

export type MailDraft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  fromAddress: string;
  updatedAt: number;
};

type MailLocalState = {
  // thread id → starred
  starred: Record<string, true>;
  // thread id → trashed
  trashed: Record<string, true>;
  // thread id → ordered list of label names
  labels: Record<string, string[]>;
  // thread id → local read/unread override. true = forced unread (the operator
  // hit "mark unread"); false = forced read. Absent = follow the server flag.
  readOverride: Record<string, boolean>;
  // saved compose drafts (local only — no backend draft store)
  drafts: MailDraft[];
};

const EMPTY: MailLocalState = {
  starred: {},
  trashed: {},
  labels: {},
  readOverride: {},
  drafts: [],
};

let state: MailLocalState = load();

function load(): MailLocalState {
  if (typeof window === "undefined") return { ...EMPTY };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<MailLocalState>;
    return {
      starred: parsed.starred ?? {},
      trashed: parsed.trashed ?? {},
      labels: parsed.labels ?? {},
      readOverride: parsed.readOverride ?? {},
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

const listeners = new Set<() => void>();

function persistAndNotify(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Quota / disabled storage — keep the in-memory copy so the current
      // session still works; it just won't survive a reload.
    }
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a bad subscriber must not break the others */
    }
  }
}

// Cross-tab sync: another tab writing the key fires a storage event here.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    state = load();
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  });
}

// ── Subscription (for useSyncExternalStore) ────────────────────────────────
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): MailLocalState {
  return state;
}

// ── Mutators ───────────────────────────────────────────────────────────────
export function toggleStar(id: string): void {
  const next = { ...state.starred };
  if (next[id]) delete next[id];
  else next[id] = true;
  state = { ...state, starred: next };
  persistAndNotify();
}

export function setStar(id: string, value: boolean): void {
  const next = { ...state.starred };
  if (value) next[id] = true;
  else delete next[id];
  state = { ...state, starred: next };
  persistAndNotify();
}

export function setTrashed(id: string, value: boolean): void {
  const next = { ...state.trashed };
  if (value) next[id] = true;
  else delete next[id];
  state = { ...state, trashed: next };
  persistAndNotify();
}

export function setTrashedMany(ids: string[], value: boolean): void {
  const next = { ...state.trashed };
  for (const id of ids) {
    if (value) next[id] = true;
    else delete next[id];
  }
  state = { ...state, trashed: next };
  persistAndNotify();
}

// Force the local read/unread state. `null` clears the override so the row
// follows the server `unread` flag again.
export function setReadOverride(id: string, value: boolean | null): void {
  const next = { ...state.readOverride };
  if (value === null) delete next[id];
  else next[id] = value;
  state = { ...state, readOverride: next };
  persistAndNotify();
}

export function setReadOverrideMany(ids: string[], value: boolean | null): void {
  const next = { ...state.readOverride };
  for (const id of ids) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  state = { ...state, readOverride: next };
  persistAndNotify();
}

export function addLabel(id: string, label: string): void {
  const clean = label.trim();
  if (!clean) return;
  const existing = state.labels[id] ?? [];
  if (existing.some((l) => l.toLowerCase() === clean.toLowerCase())) return;
  state = {
    ...state,
    labels: { ...state.labels, [id]: [...existing, clean] },
  };
  persistAndNotify();
}

export function removeLabel(id: string, label: string): void {
  const existing = state.labels[id] ?? [];
  const next = existing.filter((l) => l.toLowerCase() !== label.toLowerCase());
  const labels = { ...state.labels };
  if (next.length) labels[id] = next;
  else delete labels[id];
  state = { ...state, labels };
  persistAndNotify();
}

// ── Draft mutators ───────────────────────────────────────────────────────
export function saveDraft(draft: MailDraft): void {
  const rest = state.drafts.filter((d) => d.id !== draft.id);
  state = { ...state, drafts: [draft, ...rest] };
  persistAndNotify();
}

export function deleteDraft(id: string): void {
  state = { ...state, drafts: state.drafts.filter((d) => d.id !== id) };
  persistAndNotify();
}

// ── Derived helpers (pure reads off a snapshot) ────────────────────────────
export function isStarred(snap: MailLocalState, id: string): boolean {
  return !!snap.starred[id];
}

export function isTrashed(snap: MailLocalState, id: string): boolean {
  return !!snap.trashed[id];
}

export function labelsFor(snap: MailLocalState, id: string): string[] {
  return snap.labels[id] ?? [];
}

// Effective unread = local override if present, else the server flag.
export function effectiveUnread(
  snap: MailLocalState,
  id: string,
  serverUnread: boolean,
): boolean {
  const o = snap.readOverride[id];
  return o === undefined ? serverUnread : o;
}

// Every distinct label across all threads, sorted, for the sidebar list.
export function allLabels(snap: MailLocalState): string[] {
  const set = new Set<string>();
  for (const arr of Object.values(snap.labels)) {
    for (const l of arr) set.add(l);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
