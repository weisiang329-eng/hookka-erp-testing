import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Search,
  FileText,
  ShoppingCart,
  Users,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Settings,
  BarChart3,
  BookOpen,
  Package,
  ShieldCheck,
  Calendar,
  Layers,
  Building2,
  Bell,
  Wallet,
  Calculator,
  CreditCard,
  Ship,
  ClipboardList,
  FileX,
  Lightbulb,
  TrendingUp,
  LayoutDashboard,
  Plus,
  Download,
  ArrowRight,
  Clock,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResultCategory =
  | "pages" | "actions"
  | "sales_orders" | "customers" | "products" | "delivery_orders" | "invoices"
  | "consignment_notes"
  // Added when the palette moved to the unified /api/search endpoint — these
  // modules were never findable from search before.
  | "purchase_orders" | "purchase_invoices" | "goods_receipts" | "suppliers"
  | "production_orders" | "service_orders" | "service_cases"
  | "employees" | "leads" | "journal_entries";

type StatusTone = "green" | "amber" | "blue" | "red" | "neutral";

interface SearchResult {
  id: string;
  label: string;
  description?: string;
  href: string;
  icon: LucideIcon;
  category: ResultCategory;
  // Lifecycle status of the underlying record (shown as a pill), so a search
  // surfaces WHERE an order is across its documents at a glance — e.g. the SO
  // is "Ready to Ship" while its DO is already "Delivered".
  statusText?: string;
  statusTone?: StatusTone;
}


// Bold every occurrence of the search term inside a result label/description so
// the matched part is obvious when several rows look alike.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let i = lower.indexOf(ql, from);
  if (i === -1) return text;
  while (i !== -1) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark key={i} className="rounded-[2px] bg-[#FBEFB8] px-0.5 font-semibold text-inherit">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
    i = lower.indexOf(ql, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  green: "bg-[#E7F0E3] text-[#4F7C3A]",
  amber: "bg-[#FBF1DA] text-[#9C6F1E]",
  blue: "bg-[#E2EEF0] text-[#3E6570]",
  red: "bg-[#F6E3E0] text-[#9A3A2D]",
  neutral: "bg-[#F0ECE9] text-[#6B7280]",
};

// ---------------------------------------------------------------------------
// Static data: Pages
// ---------------------------------------------------------------------------

const PAGE_RESULTS: SearchResult[] = [
  { id: "p-dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, category: "pages" },
  { id: "p-notifications", label: "Notifications", href: "/notifications", icon: Bell, category: "pages" },
  { id: "p-sales", label: "Sales Orders", href: "/sales", icon: ShoppingCart, category: "pages" },
  { id: "p-delivery", label: "Delivery Order", href: "/delivery", icon: Truck, category: "pages" },
  { id: "p-invoices", label: "Invoices", href: "/invoices", icon: FileText, category: "pages" },
  { id: "p-consignment", label: "Consignment Order", href: "/consignment", icon: Package, category: "pages" },
  { id: "p-consignment-note", label: "Consignment Note", href: "/consignment/note", icon: ClipboardList, category: "pages" },
  { id: "p-consignment-return", label: "Consignment Return", href: "/consignment/return", icon: Ship, category: "pages" },
  { id: "p-customers", label: "Customers", href: "/customers", icon: Users, category: "pages" },
  { id: "p-production", label: "Production", href: "/production", icon: Factory, category: "pages" },
  // The Master Tracker is a TAB of the Planning page. This entry used to point
  // at /production/tracker, which has been a bare redirect since the tracker
  // moved — so the operator searched for a page and got bounced somewhere that
  // never names it. The label now says where it lives.
  //
  // The href carries ?tab=tracker to match the Production page's own "Master
  // Tracker" button (production/index.tsx: navigate("/planning?tab=tracker")).
  // NOTE: PlanningPage's `activeTab` is local state and does NOT read the query
  // string, so both links currently land on Capacity Overview with the tracker
  // one tab away. Making ?tab= load-bearing is a 10-line change in
  // src/pages/planning/index.tsx, deliberately left out of this branch to keep
  // clear of PR #275, which is editing that file.
  { id: "p-tracker", label: "Master Tracker (Planning)", href: "/planning?tab=tracker", icon: BarChart3, category: "pages" },
  { id: "p-planning", label: "Planning", href: "/planning", icon: Calendar, category: "pages" },
  { id: "p-mrp", label: "MRP", href: "/planning/mrp", icon: Layers, category: "pages" },
  { id: "p-rd", label: "R&D", href: "/rd", icon: Lightbulb, category: "pages" },
  { id: "p-products", label: "Products", href: "/products", icon: Boxes, category: "pages" },
  { id: "p-bom", label: "BOM", href: "/bom", icon: Layers, category: "pages" },
  { id: "p-inventory", label: "Inventory", href: "/inventory", icon: Package, category: "pages" },
  { id: "p-stock-value", label: "Stock Value", href: "/inventory/stock-value", icon: Calculator, category: "pages" },
  { id: "p-warehouse", label: "Warehouse", href: "/warehouse", icon: Warehouse, category: "pages" },
  { id: "p-purchase-order", label: "Purchase Order", href: "/procurement", icon: ShoppingCart, category: "pages" },
  { id: "p-grn", label: "GRN", href: "/procurement/grn", icon: ClipboardList, category: "pages" },
  { id: "p-purchase-invoice", label: "Purchase Invoice", href: "/procurement/pi", icon: CreditCard, category: "pages" },
  { id: "p-maintenance", label: "Suppliers", href: "/procurement/maintenance", icon: Building2, category: "pages" },
  { id: "p-quality", label: "QC / Quality", href: "/quality", icon: ShieldCheck, category: "pages" },
  { id: "p-accounting", label: "Accounting", href: "/accounting", icon: BookOpen, category: "pages" },
  { id: "p-cash-flow", label: "Cash Flow", href: "/accounting/cash-flow", icon: Wallet, category: "pages" },
  { id: "p-credit-notes", label: "Credit Notes", href: "/invoices/credit-notes", icon: FileX, category: "pages" },
  { id: "p-payments", label: "Payments", href: "/invoices/payments", icon: CreditCard, category: "pages" },
  { id: "p-e-invoice", label: "e-Invoice", href: "/invoices/e-invoice", icon: FileText, category: "pages" },
  { id: "p-reports", label: "Reports", href: "/reports", icon: BarChart3, category: "pages" },
  { id: "p-employees", label: "Employees", href: "/employees", icon: Users, category: "pages" },
  // Removed in chore/dead-code-sweep: "Approvals" (/approvals), "Documents"
  // (/documents) and "Customer Portal" (/portal). None of the three exists —
  // no entry in DASHBOARD_ROUTES, no directory under src/pages/, no sidebar
  // link. Searching for them dropped the operator on the dashboard shell with
  // nothing matched. README.md already recorded that the /portal module "does
  // not exist"; the palette was still advertising it.
  { id: "p-organisations", label: "Organisations", href: "/settings/organisations", icon: Settings, category: "pages" },
  { id: "p-settings", label: "Settings", href: "/settings", icon: Settings, category: "pages" },
];

// ---------------------------------------------------------------------------
// Static data: Actions
// ---------------------------------------------------------------------------

const ACTION_RESULTS: SearchResult[] = [
  { id: "a-new-so", label: "New Sales Order", description: "Create a new sales order", href: "/sales/new", icon: Plus, category: "actions" },
  { id: "a-new-do", label: "Create Delivery Order", description: "Create a new delivery order", href: "/delivery/new", icon: Plus, category: "actions" },
  { id: "a-new-invoice", label: "Create Invoice", description: "Create a new invoice", href: "/invoices/new", icon: Plus, category: "actions" },
  { id: "a-new-po", label: "Create Purchase Order", description: "Create a new purchase order", href: "/procurement/new", icon: Plus, category: "actions" },
  { id: "a-new-customer", label: "New Customer", description: "Add a new customer", href: "/customers/new", icon: Plus, category: "actions" },
  { id: "a-new-product", label: "New Product", description: "Add a new product", href: "/products/new", icon: Plus, category: "actions" },
  { id: "a-new-production", label: "New Production Order", description: "Create a production order", href: "/production/new", icon: Plus, category: "actions" },
  { id: "a-export-so", label: "Export Sales Orders", description: "Export sales orders to PDF/Excel", href: "/sales?export=true", icon: Download, category: "actions" },
  { id: "a-export-inv", label: "Export Invoices", description: "Export invoices to PDF/Excel", href: "/invoices?export=true", icon: Download, category: "actions" },
];

// ---------------------------------------------------------------------------
// Category display config
// ---------------------------------------------------------------------------

const CATEGORY_CONFIG: Record<ResultCategory, { label: string; icon: LucideIcon }> = {
  pages: { label: "Pages", icon: FileText },
  actions: { label: "Actions", icon: ArrowRight },
  sales_orders: { label: "Sales Orders", icon: ShoppingCart },
  customers: { label: "Customers", icon: Users },
  products: { label: "Products", icon: Boxes },
  delivery_orders: { label: "Delivery Orders", icon: Truck },
  invoices: { label: "Invoices", icon: FileText },
  consignment_notes: { label: "Consignment Notes", icon: ClipboardList },
  purchase_orders: { label: "Purchase Orders", icon: Package },
  purchase_invoices: { label: "Purchase Invoices", icon: FileText },
  goods_receipts: { label: "Goods Receipts", icon: Truck },
  suppliers: { label: "Suppliers", icon: Factory },
  production_orders: { label: "Production Orders", icon: Factory },
  service_orders: { label: "Service Orders", icon: ShoppingCart },
  service_cases: { label: "Service Cases", icon: ClipboardList },
  employees: { label: "Employees", icon: Users },
  leads: { label: "Sales Pipeline", icon: TrendingUp },
  journal_entries: { label: "Journal Entries", icon: FileText },
};

// Server /api/search `kind` → the palette's category + icon. A kind the UI
// hasn't mapped is skipped rather than crashing the whole result set, so the
// server can add a source before the client catches up.
const SERVER_KIND_MAP: Record<string, { category: ResultCategory; icon: LucideIcon }> = {
  sales_order: { category: "sales_orders", icon: ShoppingCart },
  customer: { category: "customers", icon: Users },
  product: { category: "products", icon: Boxes },
  delivery_order: { category: "delivery_orders", icon: Truck },
  invoice: { category: "invoices", icon: FileText },
  consignment_note: { category: "consignment_notes", icon: ClipboardList },
  purchase_order: { category: "purchase_orders", icon: Package },
  purchase_invoice: { category: "purchase_invoices", icon: FileText },
  grn: { category: "goods_receipts", icon: Truck },
  supplier: { category: "suppliers", icon: Factory },
  production_order: { category: "production_orders", icon: Factory },
  service_order: { category: "service_orders", icon: ShoppingCart },
  service_case: { category: "service_cases", icon: ClipboardList },
  employee: { category: "employees", icon: Users },
  lead: { category: "leads", icon: TrendingUp },
  journal_entry: { category: "journal_entries", icon: FileText },
};

// ---------------------------------------------------------------------------
// Recent searches (localStorage)
// ---------------------------------------------------------------------------

const RECENT_KEY = "hookka-global-search-recent";
const MAX_RECENT = 5;

function getRecentSearches(): SearchResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(result: SearchResult) {
  try {
    const current = getRecentSearches();
    const filtered = current.filter((r) => r.id !== result.id);
    const next = [result, ...filtered].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// API search hook
// ---------------------------------------------------------------------------


function useApiSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // True when every category fetch failed (timeout / offline / 5xx) and nothing
  // was collected — the UI must say "search failed", NOT "no results", or a
  // weak-wifi timeout looks like the record doesn't exist (owner-reported trap).
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- debounced query effect resets results when query is cleared */
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setFailed(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Debounce + AbortController combo: the timer needs to capture the
    // freshly-created `controller` at scheduling time, and the cleanup
    // path (when `query` changes again before 250ms elapses) must
    // clearTimeout AND abort. useTimeout's ref-based latest-fn capture
    // wouldn't pin the controller, so it would fetch with a stale signal.
    // Keep raw + disable.
    // eslint-disable-next-line no-restricted-syntax -- debounce paired with AbortController; useTimeout's latest-fn capture would lose the per-effect controller
    const timer = setTimeout(async () => {
      setLoading(true);
      // One request to /api/search replaces the six per-keystroke fetches this
      // used to fan out. Six browser requests was six connection acquisitions,
      // and on this stack that is the expensive part (a 9-row query has been
      // measured at 38.9s — see /api/admin/health/db-connect). The server runs
      // every source concurrently on ONE connection and returns pre-grouped
      // results; it also covers ten modules the fan-out never could (POs, GRNs,
      // PIs, suppliers, production/service orders, service cases, employees,
      // leads, journal entries).
      const collected: SearchResult[] = [];
      let fetchFailures = 0;
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=8`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          fetchFailures++;
        } else {
          const json = (await res.json()) as {
            success?: boolean;
            data?: { groups?: { kind: string; items: { id: string; label: string; sub: string[]; href: string }[] }[] };
          };
          for (const g of json.data?.groups ?? []) {
            const cfg = SERVER_KIND_MAP[g.kind];
            if (!cfg) continue; // unknown kind (server added a source the UI hasn't mapped) — skip, don't crash
            for (const it of g.items) {
              collected.push({
                id: `${g.kind}-${it.id}`,
                label: it.label,
                description: it.sub.join(" · "),
                href: it.href,
                icon: cfg.icon,
                category: cfg.category,
              });
            }
          }
        }
      } catch (err) {
        // AbortError is the normal debounce-cancel path, not a failure.
        if (!(err instanceof DOMException && err.name === "AbortError")) fetchFailures++;
      }

      // Retained only so the pre-existing scoring/commit block below compiles
      // unchanged; the unified endpoint returns nothing to fan out.
      const fetchers: Promise<unknown>[] = [];

      await Promise.allSettled(fetchers);

      // Rank so the most obvious matches surface first: the term in the doc
      // NUMBER (label) beats a term that only hit a secondary field (customer
      // PO / Ref in the description), and an earlier position beats a later
      // one. Stable sort keeps the server's recency order within a tie. The
      // grouping below preserves this order within each category, so searching
      // a short fragment like "249" reliably floats SO-..-249 to the top.
      const qlow = query.toLowerCase();
      const score = (r: SearchResult) => {
        const inLabel = r.label.toLowerCase().indexOf(qlow);
        if (inLabel === 0) return 0; // label starts with the term
        if (inLabel > 0) return 1; // term elsewhere in the label/number
        return 2; // matched only via the description (PO / Ref / customer)
      };
      collected.sort((a, b) => score(a) - score(b));

      if (!controller.signal.aborted) {
        setResults(collected);
        // Only flag failure when NOTHING came back AND at least one fetch
        // errored — partial results still render normally. (Aborted requests
        // can bump fetchFailures, but this whole branch is gated on !aborted.)
        setFailed(collected.length === 0 && fetchFailures > 0);
        setLoading(false);
      }
    }, 250); // debounce

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { results, loading, failed };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GlobalSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<SearchResult[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { results: apiResults, loading, failed: searchFailed } = useApiSearch(open ? query : "");

  // Filter static results
  const filteredPages = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return PAGE_RESULTS.filter(
      (r) => r.label.toLowerCase().includes(q) || r.href.toLowerCase().includes(q)
    ).slice(0, 6);
  }, [query]);

  const filteredActions = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return ACTION_RESULTS.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q))
    ).slice(0, 4);
  }, [query]);

  // Combine all results
  const allResults = useMemo(() => {
    if (!query) return [];
    return [...filteredPages, ...filteredActions, ...apiResults];
  }, [query, filteredPages, filteredActions, apiResults]);

  // Group by category for display
  const groupedResults = useMemo(() => {
    const groups: { category: ResultCategory; results: SearchResult[] }[] = [];
    const categoryOrder: ResultCategory[] = [
      "pages",
      "actions",
      "sales_orders",
      "delivery_orders",
      "invoices",
      "customers",
      "products",
      "consignment_notes",
      "purchase_orders",
      "goods_receipts",
      "purchase_invoices",
      "suppliers",
      "production_orders",
      "service_orders",
      "service_cases",
      "leads",
      "employees",
      "journal_entries",
    ];

    for (const cat of categoryOrder) {
      const items = allResults.filter((r) => r.category === cat);
      if (items.length > 0) {
        groups.push({ category: cat, results: items });
      }
    }
    return groups;
  }, [allResults]);

  // Flat list for keyboard navigation
  const flatResults = useMemo(() => {
    return groupedResults.flatMap((g) => g.results);
  }, [groupedResults]);

  // Load recent on open
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset on dialog open */
  useEffect(() => {
    if (open) {
      setRecentSearches(getRecentSearches());
      setQuery("");
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Keyboard shortcut: Ctrl+K / Cmd+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Open on demand from elsewhere (e.g. the mobile bottom-nav Search button),
  // which has no Ctrl+K to press. Fires a custom event so no shared state is
  // needed across the layout tree.
  useEffect(() => {
    const open = () => setOpen(true);
    document.addEventListener("hookka:open-search", open);
    return () => document.removeEventListener("hookka:open-search", open);
  }, []);

  // Reset selected index when results change.
  /* eslint-disable react-hooks/set-state-in-effect -- derived: keyboard cursor reset on query/result change */
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, flatResults.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const goTo = useCallback(
    (result: SearchResult) => {
      saveRecentSearch(result);
      setOpen(false);
      navigate(result.href);
    },
    [navigate]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const items = query ? flatResults : recentSearches;
      const count = items.length;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % Math.max(count, 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + Math.max(count, 1)) % Math.max(count, 1));
          break;
        case "Enter":
          e.preventDefault();
          if (count > 0 && selectedIndex < count) {
            goTo(items[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [query, flatResults, recentSearches, selectedIndex, goTo]
  );

  // Display items: recent or search results
  const showRecent = !query && recentSearches.length > 0;

  return (
    <>
      {/* Trigger button in the topbar */}
      <button
        onClick={() => setOpen(true)}
        className="relative hidden md:flex items-center h-9 w-80 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 text-sm text-[#9CA3AF] hover:border-[#6B5C32]/40 transition-colors cursor-pointer"
      >
        <Search className="h-4 w-4 mr-2 shrink-0" />
        <span className="flex-1 text-left truncate whitespace-nowrap">
          Search orders, products, customers…
        </span>
        <kbd className="hidden lg:inline-flex items-center gap-0.5 rounded border border-[#E2DDD8] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#9CA3AF] ml-2 shrink-0">
          Ctrl K
        </kbd>
      </button>

      {/* Mobile trigger */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden rounded-md p-2 text-[#6B7280] hover:bg-[#F0ECE9] transition-colors"
      >
        <Search className="h-5 w-5" />
      </button>

      {/* Modal overlay — portalled to <body> so its z-[100] lives in the ROOT
          stacking context. Rendered inside the Topbar (sticky z-30) it was
          otherwise trapped at z-30, and the DataGrid sticky header (also z-30,
          later in the DOM) painted on top of it. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] sm:pt-[12vh]"
          onClick={() => setOpen(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          {/* Dialog */}
          <div
            className="relative w-full max-w-[560px] mx-4 rounded-xl border border-[#E2DDD8] bg-white shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 border-b border-[#E2DDD8]">
              <Search className="h-4 w-4 text-[#9CA3AF] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search pages, orders, customers, products..."
                className="flex-1 h-12 bg-transparent text-sm text-[#1F1D1B] placeholder:text-[#9CA3AF] focus:outline-none"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="p-1 rounded hover:bg-[#F0ECE9] text-[#9CA3AF] hover:text-[#6B7280] transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              <kbd className="hidden sm:inline-flex items-center rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1.5 py-0.5 text-[10px] font-medium text-[#9CA3AF]">
                ESC
              </kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[360px] overflow-y-auto py-2">
              {/* Recent searches (when no query) */}
              {showRecent && (
                <div>
                  <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                    Recent
                  </div>
                  {recentSearches.map((item, idx) => (
                    <ResultItem
                      key={item.id}
                      result={item}
                      selected={idx === selectedIndex}
                      onClick={() => goTo(item)}
                      icon={<Clock className="h-4 w-4 text-[#9CA3AF]" />}
                    />
                  ))}
                </div>
              )}

              {/* No query, no recent */}
              {!query && !showRecent && (
                <div className="px-4 py-8 text-center text-sm text-[#9CA3AF]">
                  Type to search pages, orders, customers, and more...
                </div>
              )}

              {/* Search results grouped by category */}
              {query && groupedResults.length > 0 && (
                <>
                  {groupedResults.map((group) => {
                    const config = CATEGORY_CONFIG[group.category];
                    return (
                      <div key={group.category}>
                        <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          {config.label}
                        </div>
                        {group.results.map((item) => {
                          const flatIdx = flatResults.indexOf(item);
                          return (
                            <ResultItem
                              key={item.id}
                              result={item}
                              selected={flatIdx === selectedIndex}
                              onClick={() => goTo(item)}
                              query={query}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                </>
              )}

              {/* Loading indicator */}
              {query && loading && groupedResults.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-[#9CA3AF]">
                  Searching...
                </div>
              )}

              {/* Search failed (network/timeout) — must NOT masquerade as
                  "No results": on weak factory wifi a timed-out search looked
                  like the record didn't exist. */}
              {query && !loading && searchFailed && allResults.length === 0 && (
                <div className="px-4 py-8 text-center text-sm">
                  <div className="font-medium text-[#B45309]">Search failed — connection problem</div>
                  <div className="mt-1 text-[#9CA3AF]">
                    The record may still exist. Check your network and type again to retry.
                  </div>
                </div>
              )}

              {/* No results */}
              {query && !loading && !searchFailed && allResults.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-[#9CA3AF]">
                  No results for &ldquo;{query}&rdquo;
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-4 border-t border-[#E2DDD8] px-4 py-2 text-[11px] text-[#9CA3AF]">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1 py-0.5 text-[10px]">&uarr;</kbd>
                <kbd className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1 py-0.5 text-[10px]">&darr;</kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1 py-0.5 text-[10px]">&crarr;</kbd>
                Open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1 py-0.5 text-[10px]">Esc</kbd>
                Close
              </span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ResultItem sub-component
// ---------------------------------------------------------------------------

function ResultItem({
  result,
  selected,
  onClick,
  icon,
  query = "",
}: {
  result: SearchResult;
  selected: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  query?: string;
}) {
  const Icon = result.icon;
  return (
    <button
      data-selected={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
        selected
          ? "bg-[#F5F2ED] text-[#1F1D1B]"
          : "text-[#4B5563] hover:bg-[#FAF9F7]"
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7]">
        {icon || <Icon className="h-4 w-4 text-[#6B5C32]" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{highlightMatch(result.label, query)}</div>
        {result.description && (
          <div className="line-clamp-2 text-xs text-[#9CA3AF]">{highlightMatch(result.description, query)}</div>
        )}
      </div>
      {result.statusText && (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap",
            STATUS_TONE_CLASS[result.statusTone ?? "neutral"],
          )}
        >
          {result.statusText}
        </span>
      )}
      {selected && (
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
      )}
    </button>
  );
}
