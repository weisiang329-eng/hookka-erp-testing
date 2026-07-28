// Workspace tab store — the in-app browser-style tab strip. Ported from the
// Houzs ERP (hello-houzs/Houzs-ERP frontend/src/lib/workspaceTabs.ts), adapted
// to Hookka's single-app shell (owner ask 2026-07-28: "开着 SO 的时候我去别的
// module 回来不会跳不见" — open pages persist as tabs).
//
// TABS BEHAVE LIKE BROWSER TABS: drilling from a list into a detail STAYS in the
// same tab — a tab is a workspace that follows every in-content navigation (rows,
// back buttons, redirects all re-point the ACTIVE tab). Only an explicit "open"
// gesture spawns/activates another tab: a plain left-click on a SIDEBAR
// destination (which marks an open-intent just before the route changes).
//
// Sidebar open-intent dedup: if a tab is already sitting in the clicked
// destination's section, that tab is activated instead of spawning a duplicate.
// In-content wandering skips this dedup (two tabs may wander onto the same
// section, exactly like two browser tabs).
//
// Persistence: sessionStorage, ONE key, per browser tab — a reload restores the
// strip; re-login as somebody else drops it (tabs are navigation state and must
// not leak across identities).
//
// Plain module + pub/sub (useSyncExternalStore-ready).

import { getCurrentUser } from "./auth";
import { titleForPath, normalise } from "./route-titles";

export const WORKSPACE_TABS_KEY = "hookka.workspaceTabs.v1";

export interface WorkspaceTab {
  /** Stable id — the tab's identity in the strip. Its href wanders freely. */
  id: string;
  /** Where this tab currently is: pathname + search (no hash). */
  href: string;
}

export interface WorkspaceTabsSnapshot {
  tabs: readonly WorkspaceTab[];
  activeId: string | null;
}

interface StoredBlob {
  /** Owner of the strip — the signed-in user's email (per-window binding). */
  userKey: string | null;
  tabs: WorkspaceTab[];
  activeId: string | null;
  /** Monotonic id source — persisted so a reload can't re-mint a live id. */
  nextId: number;
}

let state: StoredBlob | null = null;
let snapshot: WorkspaceTabsSnapshot = { tabs: [], activeId: null };

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

function refreshSnapshot(): void {
  snapshot = { tabs: state?.tabs ?? [], activeId: state?.activeId ?? null };
}

// ── Open intent ─────────────────────────────────────────────────────────────
// The sidebar marks "the NEXT route change is an explicit open" the moment a
// destination is plain-left-clicked; the location effect consumes it. Expiry
// guards a click that never produced a navigation (link to the current page).

const OPEN_INTENT_TTL_MS = 1500;
let openIntentAt: number | null = null;

/** Call from a plain left-click on a sidebar destination, BEFORE the route
 *  changes. Modified clicks (Ctrl/Cmd/Shift/middle) must NOT mark. */
export function markWorkspaceOpenIntent(): void {
  openIntentAt = Date.now();
}

function consumeOpenIntent(): boolean {
  const at = openIntentAt;
  openIntentAt = null;
  return at !== null && Date.now() - at <= OPEN_INTENT_TTL_MS;
}

// ── Section derivation ──────────────────────────────────────────────────────

/** Trailing-slash-normalised pathname, no query/hash. */
function canonicalPath(pathname: string): string {
  const bare = (pathname || "/").split("?")[0].split("#")[0];
  return normalise(bare);
}

/**
 * The section a path belongs to — used for tab LABELS (a detail tab keeps its
 * list's name) and for the sidebar open-intent dedup. Hookka groups by the
 * FIRST path segment (/sales/123/edit → /sales), matching how the sidebar
 * carves the app.
 */
export function sectionKeyFor(pathname: string): string {
  const path = canonicalPath(pathname);
  if (path === "/") return "/";
  const seg = path.split("/").filter(Boolean)[0] ?? "";
  return `/${seg}`;
}

/** Tab label for a tab's current href = its SECTION's name, so a detail tab
 *  (e.g. one SO) keeps its list's label ("Sales Orders"), browser-tab style. */
export function workspaceTabLabel(href: string): string {
  return titleForPath(sectionKeyFor(href));
}

// ── Persistence ─────────────────────────────────────────────────────────────

const validTab = (value: unknown): value is WorkspaceTab => {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<WorkspaceTab>;
  return (
    typeof t.id === "string" &&
    /^t\d+$/.test(t.id) &&
    typeof t.href === "string" &&
    // Same-origin path only — a stored href is fed to navigate(), and "//host"
    // would be treated as protocol-relative.
    /^\/(?!\/)/.test(t.href)
  );
};

function readStored(): StoredBlob | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_TABS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const blob = parsed as Partial<StoredBlob>;
    const userKey = typeof blob.userKey === "string" ? blob.userKey : null;
    const tabs = Array.isArray(blob.tabs) ? blob.tabs.filter(validTab) : [];
    const seen = new Set<string>();
    const deduped = tabs.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    const activeId =
      typeof blob.activeId === "string" && deduped.some((t) => t.id === blob.activeId)
        ? blob.activeId
        : null;
    const maxId = deduped.reduce((m, t) => Math.max(m, Number(t.id.slice(1))), 0);
    const nextId =
      typeof blob.nextId === "number" && Number.isFinite(blob.nextId) && blob.nextId > maxId
        ? Math.floor(blob.nextId)
        : maxId + 1;
    return { userKey, tabs: deduped, activeId, nextId };
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    if (state === null || state.tabs.length === 0) sessionStorage.removeItem(WORKSPACE_TABS_KEY);
    else sessionStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled (private mode): the strip still works in memory.
  }
}

function currentUserKey(): string | null {
  const u = getCurrentUser();
  return u?.email ?? null;
}

/** Hydrate once, validating ownership. A blob owned by a DIFFERENT user is
 *  discarded; an ownerless blob (pre-auth write) is claimed by the first user. */
function ensureLoaded(): StoredBlob {
  const userKey = currentUserKey();
  if (state === null) {
    const stored = readStored();
    if (stored && (stored.userKey === null || userKey === null || stored.userKey === userKey)) {
      state = stored;
    } else {
      state = { userKey, tabs: [], activeId: null, nextId: 1 };
      if (stored) persist();
    }
    refreshSnapshot();
  }
  if (userKey !== null) {
    if (state.userKey === null) {
      state = { ...state, userKey };
      persist();
    } else if (state.userKey !== userKey) {
      state = { userKey, tabs: [], activeId: null, nextId: 1 };
      persist();
      refreshSnapshot();
    }
  }
  return state;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getWorkspaceTabsSnapshot(): WorkspaceTabsSnapshot {
  ensureLoaded();
  return snapshot;
}

export function subscribeWorkspaceTabs(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Record a navigation — the strip calls this on every route change.
 *  · First location of the session → create the first tab.
 *  · Open-intent pending (sidebar click) → activate the tab already in the
 *    destination's section, else spawn a new tab there.
 *  · Otherwise → the active tab follows: its href re-points to the location.
 */
export function recordWorkspaceVisit(pathname: string, search: string): void {
  const s = ensureLoaded();
  const href = `${canonicalPath(pathname)}${search || ""}`;
  const intent = consumeOpenIntent();

  if (s.tabs.length === 0) {
    const id = `t${s.nextId}`;
    state = { ...s, tabs: [{ id, href }], activeId: id, nextId: s.nextId + 1 };
  } else if (intent) {
    const section = sectionKeyFor(pathname);
    const existing = s.tabs.find((t) => sectionKeyFor(t.href) === section);
    if (existing) {
      if (existing.href === href && s.activeId === existing.id) return;
      state = {
        ...s,
        tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, href } : t)),
        activeId: existing.id,
      };
    } else {
      const id = `t${s.nextId}`;
      state = { ...s, tabs: [...s.tabs, { id, href }], activeId: id, nextId: s.nextId + 1 };
    }
  } else {
    const active = s.tabs.find((t) => t.id === s.activeId) ?? null;
    if (active === null) {
      const id = `t${s.nextId}`;
      state = { ...s, tabs: [...s.tabs, { id, href }], activeId: id, nextId: s.nextId + 1 };
    } else {
      if (active.href === href) return;
      state = { ...s, tabs: s.tabs.map((t) => (t.id === active.id ? { ...t, href } : t)) };
    }
  }
  persist();
  refreshSnapshot();
  emit();
}

/** Activate a tab (strip click). Returns its href for the caller to navigate. */
export function activateWorkspaceTab(id: string): string | null {
  const s = ensureLoaded();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return null;
  if (s.activeId !== id) {
    state = { ...s, activeId: id };
    persist();
    refreshSnapshot();
    emit();
  }
  return tab.href;
}

/** Move a tab to a new position (drag reorder). Pure order change. */
export function moveWorkspaceTab(id: string, toIndex: number): void {
  const s = ensureLoaded();
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const to = Math.max(0, Math.min(s.tabs.length - 1, Math.floor(toIndex)));
  if (to === from) return;
  const tabs = [...s.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  state = { ...s, tabs };
  persist();
  refreshSnapshot();
  emit();
}

/**
 * Close a tab. Returns where to navigate: closing the ACTIVE tab hands back its
 * left neighbour's href ("/" when it was the only one); closing a background
 * tab navigates nowhere (null).
 */
export function closeWorkspaceTab(id: string): { navigateTo: string | null } {
  const s = ensureLoaded();
  const index = s.tabs.findIndex((t) => t.id === id);
  if (index === -1) return { navigateTo: null };
  const wasActive = s.activeId === id;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const neighbour = wasActive ? tabs[index - 1] ?? tabs[index] ?? null : null;
  state = { ...s, tabs, activeId: wasActive ? neighbour?.id ?? null : s.activeId };
  persist();
  refreshSnapshot();
  emit();
  if (!wasActive) return { navigateTo: null };
  return { navigateTo: neighbour ? neighbour.href : "/" };
}

/** Test seam — forget in-memory state so the next read re-hydrates. */
export function resetWorkspaceTabsForTests(): void {
  state = null;
  openIntentAt = null;
  snapshot = { tabs: [], activeId: null };
}
