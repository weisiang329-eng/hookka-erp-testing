import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { formatCurrency } from "@/lib/utils";
import type { FabricTracking } from "@/types";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useToast } from "@/components/ui/toast";
import {
  Search,
  Package,
  Filter,
  Layers,
  Minus,
} from "lucide-react";

const CATEGORIES = ["ALL", "B.M-FABR", "S-FABR", "S.M-FABR", "LINING", "WEBBING"] as const;

// Substitute material lookup — maps fabric code patterns to available alternatives.
// In production this would come from the BOM template data; here we use a static map
// matching the substitutes defined in mock-data BOM components.
const FABRIC_SUBSTITUTES: Record<string, { name: string; costDiff: string }[]> = {
  "PC151": [
    { name: "PC200", costDiff: "+5%" },
    { name: "AVANI 01", costDiff: "-3%" },
  ],
  "PC200": [
    { name: "PC151", costDiff: "-5%" },
    { name: "AVANI 01", costDiff: "-8%" },
  ],
  "KN390": [
    { name: "SF-AT-15", costDiff: "-3%" },
    { name: "KN500", costDiff: "+8%" },
  ],
};

function getSubstitutesForFabric(fabricCode: string): { name: string; costDiff: string }[] | null {
  for (const prefix of Object.keys(FABRIC_SUBSTITUTES)) {
    if (fabricCode.startsWith(prefix)) {
      return FABRIC_SUBSTITUTES[prefix];
    }
  }
  return null;
}

const CATEGORY_LABELS: Record<string, string> = {
  "B.M-FABR": "Bedframe Main",
  "S-FABR": "Secondary",
  "S.M-FABR": "Sofa Main",
  LINING: "Lining",
  WEBBING: "Webbing",
};

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  "B.M-FABR": { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]" },
  "S-FABR": { bg: "bg-[#F1E6F0]", text: "text-[#6B4A6D]" },
  "S.M-FABR": { bg: "bg-emerald-100", text: "text-emerald-800" },
  LINING: { bg: "bg-[#FAEFCB]", text: "text-[#9C6F1E]" },
  WEBBING: { bg: "bg-[#E0EDF0]", text: "text-[#3E6570]" },
};

type Tab = "inventory";

export default function FabricsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: fabricsResp, loading, refresh: refreshFabrics } = useCachedJson<{ success?: boolean; data?: FabricTracking[] }>("/api/fabric-tracking");
  const fabrics: FabricTracking[] = useMemo(
    () => (fabricsResp?.data ?? (Array.isArray(fabricsResp) ? (fabricsResp as FabricTracking[]) : [])),
    [fabricsResp]
  );
  const [activeTab, setActiveTab] = useState<Tab>("inventory");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");

  const filtered = useMemo(() => {
    let list = fabrics;
    if (categoryFilter !== "ALL") {
      list = list.filter((f) => f.fabricCategory === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (f) =>
          f.fabricCode.toLowerCase().includes(q) ||
          f.fabricDescription.toLowerCase().includes(q)
      );
    }
    return list;
  }, [fabrics, categoryFilter, search]);

  const totalSOH = fabrics.reduce((s, f) => s + f.soh, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-[#6B5C32] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Fabric Tracking</h1>
        <p className="text-sm text-gray-500 mt-1">
          Material inventory matching Google Sheet &quot;Fabric&quot; tab
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard
          icon={<Layers className="h-5 w-5 text-[#6B5C32]" />}
          label="Total Fabrics"
          value={fabrics.length.toString()}
        />
        <SummaryCard
          icon={<Package className="h-5 w-5 text-[#3E6570]" />}
          label="Total SOH"
          value={`${totalSOH.toLocaleString()} m`}
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-6">
          {(
            [
              { key: "inventory", label: "Fabric Inventory", icon: Layers },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === "inventory" && (
        <InventoryTab
          fabrics={filtered}
          search={search}
          setSearch={setSearch}
          categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter}
          onPriceTierChange={async (id, field, tier) => {
            try {
              const res = await fetch(`/api/fabric-tracking/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [field]: tier }),
              });
              if (!res.ok) {
                const body = await res.json().catch(() => ({} as { error?: string }));
                throw new Error(body?.error || `HTTP ${res.status}`);
              }
              invalidateCachePrefix("/api/fabric-tracking");
              invalidateCachePrefix("/api/raw-materials");
              refreshFabrics();
            } catch (err) {
              const detail = err instanceof Error ? err.message : "try again";
              toast.error(`Failed to update price tier: ${detail}`);
              console.error(err);
              // No local optimistic state here — the controlled <select>
              // reads value straight from the cached fabric row, so the UI
              // naturally reverts to the previous tier when the request fails.
            }
          }}
          onCreatePO={(fabricCode, qty) => {
            // Deep-link into Procurement with the fabric prefilled. The
            // procurement page reads ?prefillRm + ?qty on mount, builds a
            // single POLineItem from the supplier-material-binding (auto-
            // picks main supplier + price), and opens the Create PO modal.
            navigate(
              `/procurement?prefillRm=${encodeURIComponent(fabricCode)}&qty=${qty}`,
            );
          }}
        />
      )}
    </div>
  );
}

/* ─── Summary Card ────────────────────────────────────────────────── */
function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="text-xl font-bold text-gray-900">{value}</p>
        </div>
      </div>
    </div>
  );
}

/* ─── Tab 1: Fabric Inventory ─────────────────────────────────────── */
function InventoryTab({
  fabrics,
  search,
  setSearch,
  categoryFilter,
  setCategoryFilter,
  onPriceTierChange,
  onCreatePO,
}: {
  fabrics: FabricTracking[];
  search: string;
  setSearch: (v: string) => void;
  categoryFilter: string;
  setCategoryFilter: (v: string) => void;
  onPriceTierChange: (
    id: string,
    field: "sofaPriceTier" | "bedframePriceTier",
    tier: "PRICE_1" | "PRICE_2" | "PRICE_3",
  ) => void;
  onCreatePO: (fabricCode: string, qty: number) => void;
}) {
  // DataGrid columns. Sticky fabricCode + sortable on every numeric metric +
  // built-in column toggle (visibility) + value filter (the "(All)" dropdown
  // per column header). Replaces the old static <table> + page-level search
  // input — the grid's own controls give per-column sort + filter.
  const columns: Column<FabricTracking>[] = useMemo(
    () => [
      {
        // Sticky column needs to be wide enough for the longest fabric
        // code in the catalog ("FABRIC HR805-10", "GARFIELD-2 CHERVRON",
        // 19+ chars). 140px was clipping into the Description column;
        // 200px + truncate keeps the layout clean.
        key: "fabricCode",
        label: "Fabric Code",
        type: "text",
        width: "200px",
        sortable: true,
        sticky: true,
        render: (_v, f) => (
          <span className="font-mono font-medium text-gray-900 block truncate" title={f.fabricCode}>
            {f.fabricCode}
          </span>
        ),
      },
      {
        key: "fabricDescription",
        label: "Description",
        type: "text",
        width: "200px",
        sortable: true,
        render: (_v, f) => (
          <span className="block truncate" title={f.fabricDescription}>
            {f.fabricDescription}
          </span>
        ),
      },
      {
        key: "fabricCategory",
        label: "Category",
        type: "text",
        width: "110px",
        sortable: true,
        render: (_v, f) => {
          const catColor = CATEGORY_COLORS[f.fabricCategory] ?? {
            bg: "bg-gray-100",
            text: "text-gray-600",
          };
          return (
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${catColor.bg} ${catColor.text}`}
            >
              {f.fabricCategory}
            </span>
          );
        },
      },
      {
        key: "sofaPriceTier",
        label: "Sofa Tier",
        type: "text",
        width: "100px",
        align: "center",
        sortable: true,
        // Sort keys via filterAccessor so "Price 1/2/3" order naturally.
        filterAccessor: (f) =>
          (f.sofaPriceTier ?? f.priceTier ?? "PRICE_2").replace("PRICE_", ""),
        render: (_v, f) => (
          <PriceTierSelect
            value={f.sofaPriceTier ?? f.priceTier ?? "PRICE_2"}
            onChange={(t) => onPriceTierChange(f.id, "sofaPriceTier", t)}
          />
        ),
      },
      {
        key: "bedframePriceTier",
        label: "Bedframe Tier",
        type: "text",
        width: "120px",
        align: "center",
        sortable: true,
        filterAccessor: (f) =>
          (f.bedframePriceTier ?? f.priceTier ?? "PRICE_2").replace("PRICE_", ""),
        render: (_v, f) => (
          <PriceTierSelect
            value={f.bedframePriceTier ?? f.priceTier ?? "PRICE_2"}
            onChange={(t) => onPriceTierChange(f.id, "bedframePriceTier", t)}
          />
        ),
      },
      {
        key: "price",
        label: "Price",
        type: "currency",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="text-gray-700">{formatCurrency(f.price)}</span>
        ),
      },
      {
        key: "soh",
        label: "SOH",
        type: "number",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="font-medium text-gray-900 tabular-nums">
            {f.soh.toLocaleString()}
          </span>
        ),
      },
      {
        key: "poOutstanding",
        label: "PO Outstanding",
        type: "number",
        width: "130px",
        align: "right",
        sortable: true,
        render: (_v, f) =>
          f.poOutstanding > 0 ? (
            <span className="text-[#9C6F1E] font-medium tabular-nums">
              {f.poOutstanding.toLocaleString()}
            </span>
          ) : (
            <span className="text-gray-400">
              <Minus className="inline h-3 w-3" />
            </span>
          ),
      },
      {
        key: "lastMonthUsage",
        label: "Last 30d Used",
        type: "number",
        width: "120px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="text-gray-600 tabular-nums">
            {f.lastMonthUsage.toLocaleString()}
          </span>
        ),
      },
      {
        key: "oneWeekUsage",
        label: "1-Week",
        type: "number",
        width: "90px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="text-gray-600 tabular-nums">
            {f.oneWeekUsage.toLocaleString()}
          </span>
        ),
      },
      {
        key: "twoWeeksUsage",
        label: "2-Week",
        type: "number",
        width: "90px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="text-gray-600 tabular-nums">
            {f.twoWeeksUsage.toLocaleString()}
          </span>
        ),
      },
      {
        key: "oneMonthUsage",
        label: "1-Month",
        type: "number",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <span className="text-gray-600 tabular-nums">
            {f.oneMonthUsage.toLocaleString()}
          </span>
        ),
      },
      {
        key: "shortage",
        label: "Shortage",
        type: "number",
        width: "140px",
        align: "right",
        sortable: true,
        render: (_v, f) => (
          <div className="text-right">
            {f.shortage < 0 ? (
              // Negative shortage = under-provisioned. Click to deep-link
              // into Procurement with this fabric prefilled + the absolute
              // shortage seeded as the order qty (rounded up). Procurement
              // page reads ?prefillRm + ?qty params (see procurement/index.tsx
              // useEffect on searchParams).
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const qty = Math.ceil(Math.abs(f.shortage));
                  onCreatePO(f.fabricCode, qty);
                }}
                className="font-bold tabular-nums text-[#9A3A2D] hover:underline cursor-pointer"
                title={`Click to create PO for ${f.fabricCode} — order ${Math.ceil(Math.abs(f.shortage))} ${f.fabricCode.startsWith("PC") || f.fabricCategory.includes("FABR") ? "m" : ""}`}
              >
                {f.shortage.toLocaleString()}
              </button>
            ) : (
              <span className="font-bold tabular-nums text-[#4F7C3A]">
                +{f.shortage.toLocaleString()}
              </span>
            )}
            {f.shortage < 0 &&
              (() => {
                const subs = getSubstitutesForFabric(f.fabricCode);
                if (!subs) return null;
                return (
                  <div className="text-[10px] text-[#9C6F1E] font-normal mt-0.5 text-left">
                    ⚠️ Subs:{" "}
                    {subs.map((s) => `${s.name} (${s.costDiff})`).join(", ")}
                  </div>
                );
              })()}
          </div>
        ),
      },
    ],
    [onPriceTierChange, onCreatePO],
  );

  return (
    <div className="space-y-4">
      {/* Page-level filters — search + category. DataGrid has its own
          per-column filter / sort, but the global search and category
          dropdown are kept for quick scoping (single-keystroke "show only
          PC151" filter is faster than opening the per-column filter UI). */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by code or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40 focus:border-[#6B5C32]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c === "ALL" ? "All Categories" : `${c} - ${CATEGORY_LABELS[c]}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Grid — sort, per-column filter, column visibility toggle, sticky
          fabricCode all built in. gridId persists user's column layout +
          filter state per logged-in user across sessions. */}
      <DataGrid
        columns={columns}
        data={fabrics}
        keyField="id"
        gridId="fabric-inventory"
        emptyMessage="No fabrics found"
        stickyHeader
        virtualize={fabrics.length > 100}
      />
    </div>
  );
}

/* ─── Price Tier dropdown (shared) ────────────────────────────────── */
function PriceTierSelect({
  value,
  onChange,
}: {
  value: "PRICE_1" | "PRICE_2" | "PRICE_3";
  onChange: (t: "PRICE_1" | "PRICE_2" | "PRICE_3") => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) =>
        onChange(e.target.value as "PRICE_1" | "PRICE_2" | "PRICE_3")
      }
      className={`text-xs font-semibold px-2 py-1 rounded border cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40 ${
        value === "PRICE_1"
          ? "bg-[#E0EDF0] border-[#A8CAD2] text-[#3E6570]"
          : value === "PRICE_3"
            ? "bg-[#F0E5F8] border-[#C9A8E0] text-[#5E3D80]"
            : "bg-[#FAEFCB] border-[#E8D597] text-[#9C6F1E]"
      }`}
    >
      <option value="PRICE_1">Price 1</option>
      <option value="PRICE_2">Price 2</option>
      <option value="PRICE_3">Price 3</option>
    </select>
  );
}
