import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  Wrench,
  Bell,
  QrCode,
  Wallet,
  Calculator,
  Globe,
  ClipboardCheck,
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

type ResultCategory = "pages" | "actions" | "sales_orders" | "customers" | "products" | "delivery_orders" | "invoices";

interface SearchResult {
  id: string;
  label: string;
  description?: string;
  href: string;
  icon: LucideIcon;
  category: ResultCategory;
}

// ---------------------------------------------------------------------------
// Static data: Pages
// ---------------------------------------------------------------------------

const PAGE_RESULTS: SearchResult[] = [
  { id: "p-dashboard", label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, category: "pages" },
  { id: "p-notifications", label: "Notifications", href: "/notifications", icon: Bell, category: "pages" },
  { id: "p-forecasting", label: "Forecasting", href: "/analytics/forecast", icon: TrendingUp, category: "pages" },
  { id: "p-sales", label: "Sales Orders", href: "/sales", icon: ShoppingCart, category: "pages" },
  { id: "p-delivery", label: "Delivery Order", href: "/delivery", icon: Truck, category: "pages" },
  { id: "p-invoices", label: "Invoices", href: "/invoices", icon: FileText, category: "pages" },
  { id: "p-consignment", label: "Consignment Order", href: "/consignment", icon: Package, category: "pages" },
  { id: "p-consignment-note", label: "Consignment Note", href: "/consignment/note", icon: ClipboardList, category: "pages" },
  { id: "p-consignment-return", label: "Consignment Return", href: "/consignment/return", icon: Ship, category: "pages" },
  { id: "p-customers", label: "Customers", href: "/customers", icon: Users, category: "pages" },
  { id: "p-production", label: "Production", href: "/production", icon: Factory, category: "pages" },
  { id: "p-tracker", label: "Master Tracker", href: "/production/tracker", icon: BarChart3, category: "pages" },
  { id: "p-planning", label: "Planning", href: "/planning", icon: Calendar, category: "pages" },
  { id: "p-mrp", label: "MRP", href: "/planning/mrp", icon: Layers, category: "pages" },
  { id: "p-scanner", label: "Scanner", href: "/production/scan", icon: QrCode, category: "pages" },
  { id: "p-rd", label: "R&D", href: "/rd", icon: Lightbulb, category: "pages" },
  { id: "p-products", label: "Products", href: "/products", icon: Boxes, category: "pages" },
  { id: "p-bom", label: "BOM", href: "/bom", icon: Layers, category: "pages" },
  { id: "p-inventory", label: "Inventory", href: "/inventory", icon: Package, category: "pages" },
  { id: "p-stock-value", label: "Stock Value", href: "/inventory/stock-value", icon: Calculator, category: "pages" },
  { id: "p-warehouse", label: "Warehouse", href: "/warehouse", icon: Warehouse, category: "pages" },
  { id: "p-purchase-order", label: "Purchase Order", href: "/procurement", icon: ShoppingCart, category: "pages" },
  { id: "p-grn", label: "GRN", href: "/procurement/grn", icon: ClipboardList, category: "pages" },
  { id: "p-purchase-invoice", label: "Purchase Invoice", href: "/procurement/pi", icon: CreditCard, category: "pages" },
  { id: "p-maintenance", label: "Maintenance", href: "/procurement/maintenance", icon: Wrench, category: "pages" },
  { id: "p-quality", label: "QC / Quality", href: "/quality", icon: ShieldCheck, category: "pages" },
  { id: "p-accounting", label: "Accounting", href: "/accounting", icon: BookOpen, category: "pages" },
  { id: "p-cash-flow", label: "Cash Flow", href: "/accounting/cash-flow", icon: Wallet, category: "pages" },
  { id: "p-credit-notes", label: "Credit Notes", href: "/invoices/credit-notes", icon: FileX, category: "pages" },
  { id: "p-payments", label: "Payments", href: "/invoices/payments", icon: CreditCard, category: "pages" },
  { id: "p-e-invoice", label: "e-Invoice", href: "/invoices/e-invoice", icon: FileText, category: "pages" },
  { id: "p-reports", label: "Reports", href: "/reports", icon: BarChart3, category: "pages" },
  { id: "p-employees", label: "Employees", href: "/employees", icon: Users, category: "pages" },
  { id: "p-approvals", label: "Approvals", href: "/approvals", icon: ClipboardCheck, category: "pages" },
  { id: "p-documents", label: "Documents", href: "/documents", icon: FileText, category: "pages" },
  { id: "p-portal", label: "Customer Portal", href: "/portal", icon: Globe, category: "pages" },
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

interface ApiRecord {
  id?: string;
  orderNumber?: string;
  soNumber?: string;
  doNumber?: string;
  invoiceNumber?: string;
  name?: string;
  company?: string;
  code?: string;
  description?: string;
  customerName?: string;
}

type UnknownObj = Record<string, unknown>;

function asObj(v: unknown): UnknownObj | null {
  return v && typeof v === "object" ? (v as UnknownObj) : null;
}

function asApiRecords(v: unknown): ApiRecord[] {
  return Array.isArray(v) ? (v as ApiRecord[]) : [];
}

function pickRecords(v: unknown, ...keys: string[]): ApiRecord[] {
  if (Array.isArray(v)) return asApiRecords(v);
  const obj = asObj(v);
  if (!obj) return [];
  for (const key of keys) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) return asApiRecords(candidate);
  }
  return [];
}

function useApiSearch(query: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(async () => {
      setLoading(true);
      const collected: SearchResult[] = [];

      const fetchers = [
        // Sales Orders
        fetch(`/api/sales-orders?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            const items = pickRecords(data, "salesOrders", "orders");
            items.forEach((item) => {
              const num = item.soNumber || item.orderNumber || "";
              collected.push({
                id: `so-${item.id}`,
                label: num,
                description: item.customerName || item.company || "",
                href: `/sales/${item.id}`,
                icon: ShoppingCart,
                category: "sales_orders",
              });
            });
          })
          .catch(() => {}),

        // Customers
        fetch(`/api/customers?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            const items = pickRecords(data, "customers");
            items.forEach((item) => {
              collected.push({
                id: `cust-${item.id}`,
                label: item.name || item.company || "",
                description: item.code || "",
                href: `/customers/${item.id}`,
                icon: Users,
                category: "customers",
              });
            });
          })
          .catch(() => {}),

        // Products
        fetch(`/api/products?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            const items = pickRecords(data, "products");
            items.forEach((item) => {
              collected.push({
                id: `prod-${item.id}`,
                label: item.name || item.code || "",
                description: item.code || item.description || "",
                href: `/products/${item.id}`,
                icon: Boxes,
                category: "products",
              });
            });
          })
          .catch(() => {}),

        // Delivery Orders
        fetch(`/api/delivery-orders?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            const items = pickRecords(data, "deliveryOrders", "orders");
            items.forEach((item) => {
              const num = item.doNumber || item.orderNumber || "";
              collected.push({
                id: `do-${item.id}`,
                label: num,
                description: item.customerName || item.company || "",
                href: `/delivery/${item.id}`,
                icon: Truck,
                category: "delivery_orders",
              });
            });
          })
          .catch(() => {}),

        // Invoices
        fetch(`/api/invoices?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            const items = pickRecords(data, "invoices");
            items.forEach((item) => {
              const num = item.invoiceNumber || "";
              collected.push({
                id: `inv-${item.id}`,
                label: num,
                description: item.customerName || item.company || "",
                href: `/invoices/${item.id}`,
                icon: FileText,
                category: "invoices",
              });
            });
          })
          .catch(() => {}),
      ];

      await Promise.allSettled(fetchers);

      if (!controller.signal.aborted) {
        setResults(collected);
        setLoading(false);
      }
    }, 250); // debounce

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return { results, loading };
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

  const { results: apiResults, loading } = useApiSearch(open ? query : "");

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
  useEffect(() => {
    if (open) {
      setRecentSearches(getRecentSearches());
      setQuery("");
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

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

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, flatResults.length]);

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

      {/* Modal overlay */}
      {open && (
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

              {/* No results */}
              {query && !loading && allResults.length === 0 && (
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
        </div>
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
}: {
  result: SearchResult;
  selected: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
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
        <div className="truncate font-medium">{result.label}</div>
        {result.description && (
          <div className="truncate text-xs text-[#9CA3AF]">{result.description}</div>
        )}
      </div>
      {selected && (
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
      )}
    </button>
  );
}
