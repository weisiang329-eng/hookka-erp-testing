// ---------------------------------------------------------------------------
// Multi-tab context — VS Code-style in-app tab bar.
//
// Data model
//   tabs: ordered list of { id, path, title, pinned? }
//   activeId: currently-focused tab id (mirrors location.pathname)
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

// ---- Tab shape ------------------------------------------------------------

export type TabDescriptor = {
  id: string;
  path: string;   // always includes leading slash, no trailing slash
  title: string;
  pinned?: boolean;
};

type TabsState = {
  tabs: TabDescriptor[];
  activeId: string | null;
};

type TabsContextValue = {
  tabs: TabDescriptor[];
  activeId: string | null;
  openTab: (path: string, title?: string) => void;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  switchTab: (id: string) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  togglePinned: (id: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

const STORAGE_KEY = "hookka-open-tabs";

// ---- Path → title helpers -------------------------------------------------

// Map route prefix → nice section label. Order matters — longer prefixes first
// so "/invoices/credit-notes" wins over "/invoices".
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

export function titleForPath(path: string, fallback?: string): string {
  if (fallback) return fallback;
  for (const [re, mk] of PATH_TITLES) {
    const m = re.exec(path);
    if (m) return mk(m);
  }
  // Last resort: strip leading slash, title-case the first segment.
  const seg = path.replace(/^\/+/, "").split("/")[0] || "Home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

// ---- Storage --------------------------------------------------------------

function loadInitial(): TabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed = JSON.parse(raw) as TabsState;
    if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [], activeId: null };
    return {
      tabs: parsed.tabs.filter((t) => typeof t?.path === "string"),
      activeId: parsed.activeId ?? null,
    };
  } catch {
    return { tabs: [], activeId: null };
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

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [state]);

  const openTab = useCallback((pathIn: string, title?: string) => {
    const path = normalisePath(pathIn);
    const id = makeTabId(path);
    setState((prev) => {
      const existing = prev.tabs.find((t) => t.id === id);
      if (existing) {
        // Idempotent — don't return a new object if nothing actually changes.
        // Returning `{...prev, activeId: id}` when activeId is already `id`
        // triggers pointless re-renders that cascade into the URL-sync loop.
        if (prev.activeId === id) return prev;
        return { ...prev, activeId: id };
      }
      const tab: TabDescriptor = {
        id,
        path,
        title: title ?? titleForPath(path),
      };
      return { tabs: [...prev.tabs, tab], activeId: id };
    });
  }, []);

  const switchTab = useCallback((id: string) => {
    setState((prev) => {
      if (prev.activeId === id) return prev;
      if (!prev.tabs.some((t) => t.id === id)) return prev;
      return { ...prev, activeId: id };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((prev) => {
      const idx = prev.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      if (prev.tabs[idx].pinned) return prev; // pinned tabs cannot be closed
      const next = prev.tabs.filter((t) => t.id !== id);
      let activeId = prev.activeId;
      if (activeId === id) {
        // Pick the neighbor — prefer the one to the right, fall back to left.
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        activeId = neighbor ? neighbor.id : null;
      }
      return { tabs: next, activeId };
    });
  }, []);

  const closeOthers = useCallback((id: string) => {
    setState((prev) => {
      const keep = prev.tabs.filter((t) => t.id === id || t.pinned);
      return {
        tabs: keep,
        activeId: keep.some((t) => t.id === id) ? id : keep[0]?.id ?? null,
      };
    });
  }, []);

  const closeAll = useCallback(() => {
    setState((prev) => {
      const pinned = prev.tabs.filter((t) => t.pinned);
      return {
        tabs: pinned,
        activeId: pinned[0]?.id ?? null,
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

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      openTab,
      closeTab,
      closeOthers,
      closeAll,
      switchTab,
      reorderTabs,
      togglePinned,
    }),
    [
      state,
      openTab,
      closeTab,
      closeOthers,
      closeAll,
      switchTab,
      reorderTabs,
      togglePinned,
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

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error("useTabs must be used inside a TabsProvider");
  }
  return ctx;
}

// ---- Sync helpers (rendered inside provider) ------------------------------

/**
 * Watches the URL: whenever the pathname changes, make sure there's a tab
 * for it and that it is active. Handles initial load + manual URL typing +
 * browser back/forward and sidebar link clicks without special-casing.
 *
 * Only reacts to *pathname* changes. Depending on `tabs`/`activeId` creates
 * feedback loops because TabsNavigationSync mutates those in response.
 */
// List / landing pages the user reaches via the sidebar. Navigating to one
// of these does NOT open a persistent tab — the user is browsing, not
// working on a specific record. Detail / create / edit pages (anything not
// in this list) always open a tab because the user is actively editing
// something they need to come back to.
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
  // Dashboard is the home tab — always persistent so there's something to
  // come back to when all transient pages close.
  if (path === "/dashboard") return true;
  return !NON_PERSISTENT_PATHS.has(path);
}

function TabsUrlSync() {
  const { pathname } = useLocation();
  const { openTab, switchTab, tabs: tabsRef } = useTabs();

  // Keep a live ref to tabs so the effect doesn't depend on it.
  const tabsCurrent = useRef(tabsRef);
  tabsCurrent.current = tabsRef;

  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = normalisePath(pathname);
    if (lastPath.current === path) return;
    lastPath.current = path;

    // List / landing pages don't get a tab. The user navigates via the
    // sidebar to browse, then any detail / edit click opens a persistent
    // tab for the specific record they're working on.
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

/**
 * When the context's activeId changes (e.g. user clicks another tab),
 * navigate the browser to that tab's path.
 *
 * IMPORTANT: only reacts to actual *activeId* transitions. Re-firing on
 * `pathname` or `tabs` changes would cause ping-pong navigation — when the
 * URL changes, TabsUrlSync updates activeId, which would otherwise cause
 * this effect to also navigate (redundantly) and sometimes back to a stale
 * path if the render hadn't caught up yet.
 */
function TabsNavigationSync() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { tabs, activeId } = useTabs();

  // Seeded with the initial activeId so the very first effect run is a
  // no-op — on a fresh mount we trust the URL, not whatever activeId was
  // hydrated from localStorage. If they disagree, TabsUrlSync (which runs
  // first via mount order) will update activeId to match the URL before
  // this effect gets a chance to navigate elsewhere.
  const lastActiveId = useRef<string | null>(activeId);

  // Keep live refs to pathname/tabs so the effect depends only on activeId
  // (otherwise URL-driven re-renders cause ping-pong navigation).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const tabsRefCurrent = useRef(tabs);
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
