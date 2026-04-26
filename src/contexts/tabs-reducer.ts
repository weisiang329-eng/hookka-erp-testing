// ---------------------------------------------------------------------------
// tabs-reducer.ts — pure state transitions for the in-app tab system.
//
// Why a separate file?
//   • The provider in tabs-context.tsx mixes React/Router concerns; here we
//     keep the data-shape transitions pure so tests can exercise the cap and
//     LRU-eviction rules without JSDOM or react-router.
//   • Same module is consumed by tests/tabs-cap.test.mjs via the tsx loader.
//
// Cap rationale (Option A — LRU + dirty modal):
//   We picked SAP Fiori / Salesforce Lightning's pattern over Odoo's hard
//   reject. The user opens many one-off detail pages over a long shift and
//   shouldn't have to babysit the tab strip. When the cap (10) is reached:
//     1. find the oldest non-dirty, non-pinned tab by `lastVisitedAt`
//     2. silently evict it and open the new tab
//     3. if every cap-eligible tab is dirty → stash the requested path as
//        `pendingOpenPath` and let the UI surface a modal listing dirty tabs
//        with Save / Discard / Cancel.
// ---------------------------------------------------------------------------

export const MAX_TABS = 10;

export type TabDescriptor = {
  id: string;
  path: string;
  title: string;
  pinned?: boolean;
  /** Wall-clock ms timestamp of the last time this tab was active. Used as
   *  the LRU key for cap-eviction. Updated by `setActive`. */
  lastVisitedAt: number;
};

export type TabsState = {
  tabs: TabDescriptor[];
  activeId: string | null;
  /** Tab IDs whose pages have unsaved changes. A Set is unwieldy across
   *  immutable updates so we store a record keyed by tab id. */
  dirty: Record<string, true>;
  /** Set when openTab is rejected because all cap-eligible tabs are dirty.
   *  The UI watches this to show the eviction modal. */
  pendingOpenPath: string | null;
};

export const initialState: TabsState = {
  tabs: [],
  activeId: null,
  dirty: {},
  pendingOpenPath: null,
};

/** Eviction candidate: oldest non-pinned, non-dirty tab. Returns null if
 *  none exist (caller must handle the "all dirty" case). */
export function evictionCandidate(state: TabsState): TabDescriptor | null {
  const eligible = state.tabs.filter(
    (t) => !t.pinned && !state.dirty[t.id],
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((oldest, t) =>
    t.lastVisitedAt < oldest.lastVisitedAt ? t : oldest,
  );
}

/** Build a TabDescriptor for `path`. Caller supplies id + title; this is
 *  here so the timestamp source stays consistent. */
export function makeTab(
  id: string,
  path: string,
  title: string,
  now: number,
): TabDescriptor {
  return { id, path, title, lastVisitedAt: now };
}

// ---- Reducer actions ------------------------------------------------------

export type OpenResult =
  | { kind: "noop"; state: TabsState }
  | { kind: "switched"; state: TabsState }
  | { kind: "opened"; state: TabsState; evictedId: string | null }
  | { kind: "blocked"; state: TabsState };

/**
 * Open a tab for the given path. Idempotent: if a tab already exists,
 * just becomes the active one. If the cap is reached, evicts the oldest
 * non-dirty tab; if all are dirty, stashes pendingOpenPath and returns
 * `blocked` so the UI can prompt.
 */
export function openTabAction(
  state: TabsState,
  args: { id: string; path: string; title: string; now: number },
): OpenResult {
  const { id, path, title, now } = args;
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    if (state.activeId === id) {
      // Still update lastVisitedAt so reopening a tab refreshes its LRU
      // ranking even when it's already focused.
      const tabs = state.tabs.map((t) =>
        t.id === id ? { ...t, lastVisitedAt: now } : t,
      );
      return { kind: "noop", state: { ...state, tabs } };
    }
    const tabs = state.tabs.map((t) =>
      t.id === id ? { ...t, lastVisitedAt: now } : t,
    );
    return {
      kind: "switched",
      state: { ...state, activeId: id, tabs },
    };
  }

  // New tab — check cap.
  if (state.tabs.length >= MAX_TABS) {
    const victim = evictionCandidate(state);
    if (!victim) {
      // Every existing tab is dirty or pinned — defer to UI.
      return {
        kind: "blocked",
        state: { ...state, pendingOpenPath: path },
      };
    }
    const remaining = state.tabs.filter((t) => t.id !== victim.id);
    const tab = makeTab(id, path, title, now);
    const { [victim.id]: _evictedDirty, ...dirty } = state.dirty;
    void _evictedDirty; // intentional unused — destructuring rest to drop the key
    return {
      kind: "opened",
      state: {
        ...state,
        tabs: [...remaining, tab],
        activeId: id,
        dirty,
        pendingOpenPath: null,
      },
      evictedId: victim.id,
    };
  }

  const tab = makeTab(id, path, title, now);
  return {
    kind: "opened",
    state: {
      ...state,
      tabs: [...state.tabs, tab],
      activeId: id,
      pendingOpenPath: null,
    },
    evictedId: null,
  };
}

/** Mark a tab dirty / clean. Unknown tab id is a no-op. */
export function markDirtyAction(
  state: TabsState,
  tabId: string,
  dirty: boolean,
): TabsState {
  const wasDirty = !!state.dirty[tabId];
  if (wasDirty === dirty) return state;
  if (!state.tabs.some((t) => t.id === tabId)) return state;
  if (dirty) {
    return { ...state, dirty: { ...state.dirty, [tabId]: true } };
  }
  const { [tabId]: _, ...rest } = state.dirty;
  void _;
  return { ...state, dirty: rest };
}

/** Touch lastVisitedAt when a tab becomes active. */
export function setActiveAction(
  state: TabsState,
  id: string,
  now: number,
): TabsState {
  if (state.activeId === id) return state;
  if (!state.tabs.some((t) => t.id === id)) return state;
  const tabs = state.tabs.map((t) =>
    t.id === id ? { ...t, lastVisitedAt: now } : t,
  );
  return { ...state, activeId: id, tabs };
}

/** Close a tab. Pinned tabs cannot be closed. Returns next state + the new
 *  active tab id (caller may need to navigate). */
export function closeTabAction(
  state: TabsState,
  id: string,
): { state: TabsState; nextActiveId: string | null } {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return { state, nextActiveId: state.activeId };
  if (state.tabs[idx].pinned) return { state, nextActiveId: state.activeId };
  const tabs = state.tabs.filter((t) => t.id !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
    activeId = neighbor ? neighbor.id : null;
  }
  const { [id]: _droppedDirty, ...dirty } = state.dirty;
  void _droppedDirty;
  return {
    state: { ...state, tabs, activeId, dirty },
    nextActiveId: activeId,
  };
}

/** Clear the deferred-open intent (modal cancelled, or a dirty tab got
 *  saved/discarded so we proceeded). */
export function clearPendingAction(state: TabsState): TabsState {
  if (state.pendingOpenPath === null) return state;
  return { ...state, pendingOpenPath: null };
}
