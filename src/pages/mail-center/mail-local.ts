// ---------------------------------------------------------------------------
// Mail Center — client-side state for compose DRAFTS only.
//
// Star / labels / trash / mark-unread USED to live here in localStorage
// because the backend had no columns for them. They are now DB-backed:
//   • star        → email_threads.starred         (PATCH { starred })
//   • labels      → email_threads.labels (JSON)    (PATCH { labels })
//   • trash       → email_threads.trashed_at       (PATCH { trashed })
//   • mark unread → email_threads.unread           (PATCH { unread })
// so they sync across users/devices via the API (see mail-actions.ts).
//
// Compose DRAFTS remain LOCAL: there is no draft table this round, so saved
// drafts are kept in localStorage, keyed per device, with a tiny pub/sub so
// the inbox Drafts folder and the compose dialog stay in sync within and
// across tabs. GAP (still reported to owner): drafts do NOT sync between
// users/devices and are lost if site data is cleared. Promoting them needs an
// email_drafts table + CRUD endpoints.
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
  // saved compose drafts (local only — no backend draft store)
  drafts: MailDraft[];
};

const EMPTY: MailLocalState = {
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
