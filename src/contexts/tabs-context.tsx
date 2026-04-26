// ---------------------------------------------------------------------------
// Multi-tab context — VS Code-style in-app tab bar.
//
// Data model
//   tabs: ordered list of { id, path, title, pinned?, lastVisitedAt }
//   activeId: currently-focused tab id (mirrors location.pathname)
//   dirty: record of tab ids whose pages have unsaved changes
//   pendingOpenPath: deferred-open intent when cap modal is visible
//
// Cap behaviour (MAX_TABS, see ./tabs-reducer)
//   • At 10 open tabs, opening an 11th evicts the oldest non-pinned,
//     non-dirty tab (LRU). If every tab is dirty, the UI surfaces a modal
//     so the user picks one to save/discard. Pattern matches SAP Fiori
//     shell + Salesforce Lightning console; not Odoo's hard-reject toast.
//
// Design notes
//   • The browser URL is the single source of truth for which page is
//     visible. Tabs are a reactive reflection of the navigation history the
//     user wants to keep around.
//   • The TabsSyncer hook (rendered inside the provider) watches
//     `location.pathname` and ensures there is always exactly one tab
//     matching it, creating a new tab if needed and making it active.
//   • Closing a tab navigates to the neighbor so the browser URL never
//     falls out of sync.
//   • Tab IDs are path-based (plus a counter if duplicates need to exist)
//     to keep localStorage-restored sessions deterministic.
// ---------------------------------------------------------------------------
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  initialState,
  openTabAction,
  closeTabAction,
  markDirtyAction,
  setActiveAction,
  clearPendingAction,
  type TabsState,
  type TabDescriptor as ReducerTabDescriptor,
} from "./tabs-reducer";

// Re-export the cap so UI components don't need to reach into the reducer.
export { MAX_TABS } from "./tabs-reducer";

// ---- Tab shape ------------------------------------------------------------

export type TabDescriptor = ReducerTabDescriptor;

type TabsContextValue = {
  tabs: TabDescriptor[];
  activeId: string | null;
  dirtyIds: ReadonlySet<string>;
  pendingOpenPath: string | null;
  openTab: (path: string, title?: string) => void;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  switchTab: (id: string) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  togglePinned: (id: string) => void;
  markDirty: (tabId: string, dirty: boolean) => void;
  cancelPendingOpen: () => void;
  /** Save/discard happened on a dirty tab; close it and try the deferred open. */
  resolveCapModal: (closeTabId: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

const STORAGE_KEY = "hookka-open-tabs";

// ---- Path → title helpers -------------------------------------------------

const PATH_TITLES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^\/dashboard\/?$/, () => "Dashboard"],
  [/^\/notifications\/?$/, () => "Notifications"],
  [/^\/analytics\/forecast\/?$/, () => "Forecasting"],
  [/^\/sales\/create\/?$/, () => "New Sales Order"],
  [/^\/sales\/([^/]+)\/edit\/?$/, (m) => `Edit ${m[1]}`],
  [/^\/sales\/([^/]+)\/?$/, (m) => `Sales · ${m[1]}`],
  [/^\/sales\/?$/, () => "Sales Orders"],
  [/^\/production\/department\/([^/]+)\/?$/, (m) => `Dept · ${m[1]}`],
  [/^\/production\/scan\/?$/, () => "Scanner"],
  [/^\/production\/fg-scan\/?$/, () => "FG Scanner"],
  [/^\/production\/([^/]+)\/?$/, (m) => `Production · ${m[1]}`],
  [/^\/production\/?$/, () => "Production"],
  [/^\/planning\/mrp\/?$/, () => "MRP"],
  [/^\/planning\/?$/, () => "Planning"],
  [/^\/delivery\/([^/]+)\/?$/, (m) => `DO · ${m[1]}`],
  [/^\/delivery\/?$/, () => "Delivery Orders"],
  [/^\/invoices\/credit-notes\/?$/, () => "Credit Notes"],
  [/^\/invoices\/debit-notes\/?$/, () => "Debit Notes"],
  [/^\/invoices\/e-invoice\/?$/, () => "e-Invoice"],
  [/^\/invoices\/payments\/?$/, () => "Payments"],
  [/^\/invoices\/([^/]+)\/?$/, (m) => `Invoice · ${m[1]}`],
  [/^\/invoices\/?$/, () => "Invoices"],
  [/^\/procurement\/grn\/?$/, () => "GRN"],
  [/^\/procurement\/pi\/?$/, () => "Purchase Invoices"],
  [/^\/procurement\/pricing\/?$/, () => "Pricing"],
  [/^\/procurement\/in-transit\/?$/, () => "In Transit"],
  [/^\/procurement\/maintenance\/?$/, () => "Proc Maintenance"],
  [/^\/procurement\/([^/]+)\/?$/, (m) => `PO · ${m[1]}`],
  [/^\/procurement\/?$/, () => "Purchase Orders"],
  [/^\/inventory\/fabrics\/?$/, () => "Fabrics"],
  [/^\/inventory\/stock-value\/?$/, () => "Stock Value"],
  [/^\/inventory\/?$/, () => "Inventory"],
  [/^\/bom\/?$/, () => "BOM"],
  [/^\/products\/([^/]+)\/bom\/?$/, (m) => `BOM · ${m[1]}`],
  [/^\/products\/?$/, () => "Products"],
  [/^\/customers\/?$/, () => "Customers"],
  [/^\/employees\/?$/, () => "Employees"],
  [/^\/warehouse\/?$/, () => "Warehouse"],
  [/^\/accounting\/cash-flow\/?$/, () => "Cash Flow"],
  [/^\/accounting\/?$/, () => "Accounting"],
  [/^\/quality\/?$/, () => "Quality"],
  [/^\/rd\/([^/]+)\/?$/, (m) => `R&D · ${m[1]}`],
  [/^\/rd\/?$/, () => "R&D"],
  [/^\/reports\/?$/, () => "Reports"],
  [/^\/documents\/?$/, () => "Documents"],
  [/^\/approvals\/?$/, () => "Approvals"],
  [/^\/maintenance\/?$/, () => "Maintenance"],
  [/^\/settings\/organisations\/?$/, () => "Organisations"],
  [/^\/settings\/variants\/?$/, () => "Variants"],
  [/^\/settings\/?$/, () => "Settings"],
  [/^\/consignment\/create\/?$/, () => "New Consignment"],
  [/^\/consignment\/note\/?$/, () => "Consignment Note"],
  [/^\/consignment\/return\/?$/, () => "Consignment Return"],
  [/^\/consignment\/([^/]+)\/?$/, (m) => `Consignment · ${m[1]}`],
  [/^\/consignment\/?$/, () => "Consignment"],
];

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper for the tab provider; HMR penalty is acceptable
export function titleForPath(path: string, fallback?: string): string {
  if (fallback) return fallback;
  for (const [re, mk] of PATH_TITLES) {
    const m = re.exec(path);
    if (m) return mk(m);
  }
  const seg = path.replace(/^\/+/, "").split("/")[0] || "Home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

// ---- Storage --------------------------------------------------------------

function loadInitial(): TabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as {
      tabs?: Array<Partial<TabDescriptor>>;
      activeId?: string | null;
    } | null;
    if (!parsed || !Array.isArray(parsed.tabs)) return initialState;
    const now = Date.now();
    const persistedTabs = parsed.tabs;
    const tabs: TabDescriptor[] = [];
    for (let i = 0; i < persistedTabs.length; i++) {
      const t = persistedTabs[i];
      if (!t || typeof t.path !== "string" || typeof t.id !== "string" || typeof t.title !== "string") continue;
      tabs.push({
        id: t.id,
        path: t.path,
        title: t.title,
        pinned: t.pinned,
        // Backfill lastVisitedAt for tabs persisted before this field existed
        // — preserve relative order so the strip ordering is the LRU baseline.
        lastVisitedAt: typeof t.lastVisitedAt === "number" ? t.lastVisitedAt : now - (persistedTabs.length - i),
      });
    }
    return {
      tabs,
      activeId: parsed.activeId ?? null,
      // Dirty state is per-session (form changes are in component state, which
      // is gone after reload). Always start clean on hydrate.
      dirty: {},
      pendingOpenPath: null,
    };
  } catch {
    return initialState;
  }
}

function normalisePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function makeTabId(path: string): string {
  return `tab:${normalisePath(path)}`;
}

// ---- Provider -------------------------------------------------------------

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TabsState>(loadInitial);

  // Persist on every change. Dirty state and pendingOpenPath are session-only.
  useEffect(() => {
    try {
      const persisted = {
        tabs: state.tabs,
        activeId: state.activeId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [state.tabs, state.activeId]);

  const openTab = useCallback((pathIn: string, title?: string) => {
    const path = normalisePath(pathIn);
    const id = makeTabId(path);
    setState((prev) => {
      const result = openTabAction(prev, {
        id,
        path,
        title: title ?? titleForPath(path),
        now: Date.now(),
      });
      return result.state;
    });
  }, []);

  const switchTab = useCallback((id: string) => {
    setState((prev) => setActiveAction(prev, id, Date.now()));
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((prev) => closeTabAction(prev, id).state);
  }, []);

  const closeOthers = useCallback((id: string) => {
    setState((prev) => {
      const keep = prev.tabs.filter((t) => t.id === id || t.pinned);
      const dropped = prev.tabs.filter((t) => t.id !== id && !t.pinned);
      const dirty = { ...prev.dirty };
      for (const d of dropped) delete dirty[d.id];
      return {
        ...prev,
        tabs: keep,
        activeId: keep.some((t) => t.id === id) ? id : keep[0]?.id ?? null,
        dirty,
      };
    });
  }, []);

  const closeAll = useCallback(() => {
    setState((prev) => {
      const pinned = prev.tabs.filter((t) => t.pinned);
      const dirty: Record<string, true> = {};
      for (const p of pinned) if (prev.dirty[p.id]) dirty[p.id] = true;
      return {
        ...prev,
        tabs: pinned,
        activeId: pinned[0]?.id ?? null,
        dirty,
      };
    });
  }, []);

  const reorderTabs = useCallback((fromIdx: number, toIdx: number) => {
    setState((prev) => {
      if (
        fromIdx < 0 || toIdx < 0 ||
        fromIdx >= prev.tabs.length || toIdx >= prev.tabs.length ||
        fromIdx === toIdx
      ) {
        return prev;
      }
      const next = [...prev.tabs];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { ...prev, tabs: next };
    });
  }, []);

  const togglePinned = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.id === id ? { ...t, pinned: !t.pinned } : t,
      ),
    }));
  }, []);

  const markDirty = useCallback((tabId: string, dirty: boolean) => {
    setState((prev) => markDirtyAction(prev, tabId, dirty));
  }, []);

  const cancelPendingOpen = useCallback(() => {
    setState((prev) => clearPendingAction(prev));
  }, []);

  const resolveCapModal = useCallback((closeTabId: string) => {
    setState((prev) => {
      const pending = prev.pendingOpenPath;
      if (!pending) return prev;
      // Close the user-selected dirty tab first…
      const { state: afterClose } = closeTabAction(
        // Mark it clean so closeTabAction proceeds (it's not pinned by
        // construction since pinned tabs can't be selected by the modal,
        // and dirty doesn't block close — only the cap-modal flow forces
        // explicit user resolution).
        markDirtyAction(prev, closeTabId, false),
        closeTabId,
      );
      // …then retry the deferred open.
      const path = normalisePath(pending);
      const id = makeTabId(path);
      const result = openTabAction(afterClose, {
        id,
        path,
        title: titleForPath(path),
        now: Date.now(),
      });
      return { ...result.state, pendingOpenPath: null };
    });
  }, []);

  const dirtyIds = useMemo<ReadonlySet<string>>(
    () => new Set(Object.keys(state.dirty)),
    [state.dirty],
  );

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      dirtyIds,
      pendingOpenPath: state.pendingOpenPath,
      openTab,
      closeTab,
      closeOthers,
      closeAll,
      switchTab,
      reorderTabs,
      togglePinned,
      markDirty,
      cancelPendingOpen,
      resolveCapModal,
    }),
    [
      state.tabs,
      state.activeId,
      state.pendingOpenPath,
      dirtyIds,
      openTab,
      closeTab,
      closeOthers,
      closeAll,
      switchTab,
      reorderTabs,
      togglePinned,
      markDirty,
      cancelPendingOpen,
      resolveCapModal,
    ],
  );

  return (
    <TabsContext.Provider value={value}>
      <TabsUrlSync />
      <TabsNavigationSync />
      {children}
    </TabsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- context consumer hook lives next to its provider
export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabs must be used inside a TabsProvider");
  }
  return ctx;
}

// ---- Sync helpers (rendered inside provider) ------------------------------

const NON_PERSISTENT_PATHS = new Set<string>([
  "/notifications",
  "/analytics/forecast",
  "/sales",
  "/delivery",
  "/invoices",
  "/invoices/credit-notes",
  "/invoices/debit-notes",
  "/invoices/payments",
  "/invoices/e-invoice",
  "/consignment",
  "/consignment/note",
  "/consignment/return",
  "/customers",
  "/production",
  "/production/scan",
  "/production/tracker",
  "/production/fg-scan",
  "/planning",
  "/planning/mrp",
  "/products",
  "/bom",
  "/inventory",
  "/inventory/fabrics",
  "/inventory/stock-value",
  "/warehouse",
  "/procurement",
  "/procurement/in-transit",
  "/procurement/grn",
  "/procurement/pi",
  "/procurement/pricing",
  "/procurement/maintenance",
  "/rd",
  "/quality",
  "/accounting",
  "/accounting/cash-flow",
  "/reports",
  "/employees",
  "/maintenance",
  "/settings",
  "/settings/users",
  "/settings/organisations",
]);

function shouldPersistTab(path: string): boolean {
  if (path === "/dashboard") return true;
  return !NON_PERSISTENT_PATHS.has(path);
}

function TabsUrlSync() {
  const { pathname } = useLocation();
  const { openTab, switchTab, tabs: tabsRef } = useTabs();

  const tabsCurrent = useRef(tabsRef);
  // eslint-disable-next-line react-hooks/refs -- live-ref pattern: writing on each render keeps the effect's dep list minimal and avoids ping-pong navigation
  tabsCurrent.current = tabsRef;

  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = normalisePath(pathname);
    if (lastPath.current === path) return;
    lastPath.current = path;

    if (!shouldPersistTab(path)) return;

    const id = makeTabId(path);
    const existing = tabsCurrent.current.find((t) => t.id === id);
    if (existing) {
      switchTab(id);
    } else {
      openTab(path);
    }
  }, [pathname, openTab, switchTab]);

  return null;
}

function TabsNavigationSync() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { tabs, activeId } = useTabs();

  const lastActiveId = useRef<string | null>(activeId);

  const pathnameRef = useRef(pathname);
  // eslint-disable-next-line react-hooks/refs -- live-ref pattern: see TabsUrlSync rationale above
  pathnameRef.current = pathname;
  const tabsRefCurrent = useRef(tabs);
  // eslint-disable-next-line react-hooks/refs -- live-ref pattern: see TabsUrlSync rationale above
  tabsRefCurrent.current = tabs;

  useEffect(() => {
    if (lastActiveId.current === activeId) return;
    lastActiveId.current = activeId;

    if (!activeId) return;
    const tab = tabsRefCurrent.current.find((t) => t.id === activeId);
    if (!tab) return;
    const currentNorm = normalisePath(pathnameRef.current);
    if (tab.path !== currentNorm) {
      navigate(tab.path);
    }
  }, [activeId, navigate]);

  return null;
}

// ---- Active-tab dirty hook ------------------------------------------------

/**
 * Convenience hook for pages: tracks "is the form dirty?" and reports it
 * upward so the cap-eviction logic knows whether this tab is safe to close.
 *
 * Pages call `useActiveTabDirty(myDirtyFlag)` once with a boolean; the
 * hook syncs that flag to the *currently-active* tab (which is always
 * the tab hosting this page, given TabbedOutlet only mounts the active
 * pane). On unmount it clears the flag so a closed page never pins its
 * tab as dirty forever.
 */
// eslint-disable-next-line react-refresh/only-export-components -- co-located hook for the tab provider; HMR penalty is acceptable
export function useActiveTabDirty(isDirty: boolean): void {
  const { activeId, markDirty } = useTabs();
  const lastTabId = useRef<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    lastTabId.current = activeId;
    markDirty(activeId, isDirty);
  }, [activeId, isDirty, markDirty]);

  useEffect(() => {
    return () => {
      const tid = lastTabId.current;
      if (tid) markDirty(tid, false);
    };
    // markDirty is stable (useCallback). The cleanup needs to run only on
    // unmount, not on every dep change, so we deliberately exclude it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

