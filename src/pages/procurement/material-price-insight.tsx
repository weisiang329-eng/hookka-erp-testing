// ---------------------------------------------------------------------------
// Material Price Insight modal — comparison + history.
//
// Wei Siang 2026-06-19: the Supplier SKU & Costing list "felt duplicate" — he
// wanted to SEE our cost-price history per material and a cross-supplier
// comparison (which supplier is cheapest for a material). This modal layers
// both views on top of the SAME binding data the SKU & Costing grid already
// holds — no schema change.
//
//   1. Compare tab  — every supplier that sells this internal material code,
//                      with its CURRENT price, sorted cheapest-first, the
//                      cheapest row highlighted. Source: the in-memory binding
//                      list passed from the page (no extra fetch).
//   2. History tab  — effective-dated price changes for a supplier + material,
//                      read from GET /api/price-history. Rows accumulate when a
//                      binding's price is edited (supplier-materials PUT now
//                      records a price_histories entry on every price move).
//
// Read-only. English only.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, History, Scale, TrendingUp, X } from "lucide-react";

// The slice of the page's SupplierSKU shape this modal needs. Kept structural
// (not an import) so the modal stays decoupled from the page component.
export type PriceInsightSku = {
  id: string;
  internalRMCode: string;
  materialName: string;
  supplierId: string;
  supplierName?: string;
  supplierSku: string;
  unitPriceSen: number;
  currency: string;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
  validFrom: string;
  validTo: string;
};

type PriceHistoryEntry = {
  id: string;
  bindingId: string;
  supplierId: string;
  materialCode: string;
  oldPrice: number;
  newPrice: number;
  currency: string;
  changedDate: string;
  changedBy: string;
  reason: string;
  approvalStatus: string;
};

type CompareRow = PriceInsightSku & { isCheapest: boolean };

type TabId = "compare" | "history";

export function MaterialPriceInsightModal({
  materialCode,
  materialName,
  skuList,
  supplierNameById,
  initialSupplierId,
  onClose,
}: {
  materialCode: string;
  materialName: string;
  // ALL bindings the page has loaded (any supplier, any material). The modal
  // filters down to this materialCode itself.
  skuList: PriceInsightSku[];
  supplierNameById: Record<string, string>;
  // When opened from a specific row, default the History tab's supplier.
  initialSupplierId?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("compare");

  // ---- Comparison: every supplier selling this internal material code ----
  const compareRows: CompareRow[] = useMemo(() => {
    const rows = skuList
      .filter((s) => s.internalRMCode === materialCode)
      .map((s) => ({
        ...s,
        supplierName: s.supplierName || supplierNameById[s.supplierId] || s.supplierId,
      }));
    // Cheapest-first. A price of 0 (unpriced) sorts to the bottom so it never
    // masquerades as the best deal.
    const priced = rows.filter((r) => r.unitPriceSen > 0);
    const unpriced = rows.filter((r) => r.unitPriceSen <= 0);
    priced.sort((a, b) => a.unitPriceSen - b.unitPriceSen);
    const minPrice = priced.length > 0 ? priced[0].unitPriceSen : -1;
    return [...priced, ...unpriced].map((r) => ({
      ...r,
      isCheapest: r.unitPriceSen > 0 && r.unitPriceSen === minPrice,
    }));
  }, [skuList, materialCode, supplierNameById]);

  const cheapest = compareRows.find((r) => r.isCheapest);
  const pricedCount = compareRows.filter((r) => r.unitPriceSen > 0).length;
  const priceSpread = useMemo(() => {
    const priced = compareRows.filter((r) => r.unitPriceSen > 0);
    if (priced.length < 2) return null;
    const min = priced[0].unitPriceSen;
    const max = priced[priced.length - 1].unitPriceSen;
    return { min, max, diff: max - min, pct: min > 0 ? ((max - min) / min) * 100 : 0 };
  }, [compareRows]);

  // ---- History: which supplier to look up (defaults to opened-from row) ----
  const [historySupplierId, setHistorySupplierId] = useState<string>(
    initialSupplierId || cheapest?.supplierId || compareRows[0]?.supplierId || "",
  );

  const [history, setHistory] = useState<PriceHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "history" || !historySupplierId || !materialCode) return;
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- spinner reset + async fetch result writes */
    setHistoryLoading(true);
    setHistoryError(null);
    const url = `/api/price-history?materialCode=${encodeURIComponent(
      materialCode,
    )}&supplierId=${encodeURIComponent(historySupplierId)}`;
    fetch(url)
      .then((res) => res.json().catch(() => ({}) as unknown))
      .then((body) => {
        if (cancelled) return;
        const data = (body as { data?: PriceHistoryEntry[] })?.data;
        setHistory(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (cancelled) return;
        setHistoryError("Could not load price history.");
      })
      .finally(() => {
        if (cancelled) return;
        setHistoryLoading(false);
      });
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      cancelled = true;
    };
  }, [tab, historySupplierId, materialCode]);

  const compareColumns: Column<CompareRow>[] = useMemo(
    () => [
      {
        key: "supplierName",
        label: "Supplier",
        type: "text",
        sortable: true,
        render: (_v: unknown, row: CompareRow) => (
          <span className="flex items-center gap-2">
            <span className="text-[#1F1D1B]">{row.supplierName}</span>
            {row.isCheapest && (
              <Badge className="bg-green-50 text-green-800 border-green-300">Cheapest</Badge>
            )}
            {row.isMainSupplier && (
              <Badge className="bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/30">Main</Badge>
            )}
          </span>
        ),
      },
      { key: "supplierSku", label: "Supplier Code", type: "text", width: "140px", sortable: true },
      {
        key: "unitPriceSen",
        label: "Unit Price",
        width: "130px",
        align: "right",
        sortable: true,
        render: (_v: unknown, row: CompareRow) =>
          row.unitPriceSen > 0 ? (
            <span className={row.isCheapest ? "font-semibold text-[#4F7C3A]" : "text-[#1F1D1B]"}>
              {formatCurrency(row.unitPriceSen, row.currency)}
            </span>
          ) : (
            <span className="text-[#9CA3AF] text-xs">no price</span>
          ),
      },
      {
        key: "vsCheapest",
        label: "vs Cheapest",
        width: "120px",
        align: "right",
        sortable: false,
        render: (_v: unknown, row: CompareRow) => {
          if (!cheapest || row.unitPriceSen <= 0 || row.isCheapest) {
            return <span className="text-[#9CA3AF] text-xs">{row.isCheapest ? "—" : ""}</span>;
          }
          const diff = row.unitPriceSen - cheapest.unitPriceSen;
          const pct = cheapest.unitPriceSen > 0 ? (diff / cheapest.unitPriceSen) * 100 : 0;
          return (
            <span className="text-xs font-medium text-[#9A3A2D]">
              +{formatCurrency(diff, row.currency)} ({pct.toFixed(0)}%)
            </span>
          );
        },
      },
      {
        key: "leadTimeDays",
        label: "Lead Time",
        width: "100px",
        align: "right",
        sortable: true,
        render: (_v: unknown, row: CompareRow) => <span>{row.leadTimeDays}d</span>,
      },
      { key: "moq", label: "MOQ", type: "number", width: "80px", align: "right", sortable: true },
      {
        key: "validTo",
        label: "Valid Until",
        width: "120px",
        render: (_v: unknown, row: CompareRow) => (
          <span className="text-xs text-[#6B7280]">{row.validTo ? formatDate(row.validTo) : "—"}</span>
        ),
      },
    ],
    [cheapest],
  );

  const historyColumns: Column<PriceHistoryEntry>[] = useMemo(
    () => [
      {
        key: "changedDate",
        label: "Effective Date",
        width: "130px",
        sortable: true,
        render: (_v: unknown, row: PriceHistoryEntry) => (
          <span className="text-[#1F1D1B]">{row.changedDate ? formatDate(row.changedDate) : "—"}</span>
        ),
      },
      {
        key: "oldPrice",
        label: "Old Price",
        width: "120px",
        align: "right",
        render: (_v: unknown, row: PriceHistoryEntry) => (
          <span className="text-[#6B7280]">{formatCurrency(row.oldPrice, row.currency)}</span>
        ),
      },
      {
        key: "newPrice",
        label: "New Price",
        width: "120px",
        align: "right",
        render: (_v: unknown, row: PriceHistoryEntry) => (
          <span className="text-[#1F1D1B] font-medium">{formatCurrency(row.newPrice, row.currency)}</span>
        ),
      },
      {
        key: "change",
        label: "Change",
        width: "140px",
        align: "right",
        render: (_v: unknown, row: PriceHistoryEntry) => {
          const diff = row.newPrice - row.oldPrice;
          if (diff === 0) return <span className="text-[#9CA3AF] text-xs">no change</span>;
          const pct = row.oldPrice > 0 ? (diff / row.oldPrice) * 100 : 0;
          const up = diff > 0;
          return (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                up ? "text-[#9A3A2D]" : "text-[#4F7C3A]"
              }`}
            >
              {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {up ? "+" : ""}
              {formatCurrency(diff, row.currency)} ({pct.toFixed(0)}%)
            </span>
          );
        },
      },
      {
        key: "reason",
        label: "Reason",
        sortable: true,
        render: (_v: unknown, row: PriceHistoryEntry) => (
          <span className="text-[#6B7280] text-xs">{row.reason || "—"}</span>
        ),
      },
      { key: "changedBy", label: "By", width: "110px", type: "text" },
    ],
    [],
  );

  const historySuppliers = useMemo(() => {
    // Suppliers that sell this material — the dropdown options for the History
    // tab. Sorted by name for predictability.
    const seen = new Map<string, string>();
    for (const r of compareRows) {
      if (!seen.has(r.supplierId)) {
        seen.set(r.supplierId, r.supplierName || r.supplierId);
      }
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [compareRows]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-[#6B5C32]" />
              Price Insight
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">
              <span className="font-medium text-[#374151]">{materialCode}</span>
              {materialName ? ` — ${materialName}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 border-b border-[#E2DDD8]">
          <button
            type="button"
            onClick={() => setTab("compare")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === "compare"
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Scale className="h-4 w-4" />
            Compare Suppliers ({compareRows.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("history")}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === "history"
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <History className="h-4 w-4" />
            Price History
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto">
          {tab === "compare" && (
            <div className="space-y-4">
              {/* Summary strip */}
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
                <div className="rounded-lg border border-[#E2DDD8] p-3">
                  <p className="text-xs text-[#6B7280]">Cheapest supplier</p>
                  <p className="text-sm font-semibold text-[#4F7C3A] mt-0.5">
                    {cheapest ? cheapest.supplierName : "—"}
                  </p>
                  <p className="text-xs text-[#9CA3AF]">
                    {cheapest ? formatCurrency(cheapest.unitPriceSen, cheapest.currency) : "no priced supplier"}
                  </p>
                </div>
                <div className="rounded-lg border border-[#E2DDD8] p-3">
                  <p className="text-xs text-[#6B7280]">Suppliers offering this</p>
                  <p className="text-xl font-bold text-[#1F1D1B] mt-0.5">{pricedCount}</p>
                  <p className="text-xs text-[#9CA3AF]">with a current price</p>
                </div>
                <div className="rounded-lg border border-[#E2DDD8] p-3">
                  <p className="text-xs text-[#6B7280]">Price spread</p>
                  {priceSpread ? (
                    <>
                      <p className="text-sm font-semibold text-[#9A3A2D] mt-0.5">
                        +{formatCurrency(priceSpread.diff)}
                      </p>
                      <p className="text-xs text-[#9CA3AF]">
                        {priceSpread.pct.toFixed(0)}% cheapest → dearest
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-[#9CA3AF] mt-0.5">—</p>
                  )}
                </div>
              </div>

              <DataGrid<CompareRow>
                columns={compareColumns}
                data={compareRows}
                keyField="id"
                gridId="material-price-compare"
                rowClassName={(row) => (row.isCheapest ? "bg-green-50/60" : "")}
                emptyMessage="No suppliers found for this material."
                stickyHeader
                maxHeight="50vh"
              />
            </div>
          )}

          {tab === "history" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-sm text-[#374151]">Supplier:</label>
                <select
                  value={historySupplierId}
                  onChange={(e) => setHistorySupplierId(e.target.value)}
                  className="h-9 px-3 rounded border border-[#D8D2CC] bg-white text-sm min-w-[220px]"
                >
                  {historySuppliers.length === 0 && <option value="">No supplier</option>}
                  {historySuppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              {historyLoading ? (
                <div className="flex items-center justify-center h-40">
                  <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[#6B5C32]" />
                </div>
              ) : historyError ? (
                <p className="text-sm text-[#9A3A2D] py-8 text-center">{historyError}</p>
              ) : history.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#E2DDD8] py-10 text-center">
                  <History className="h-6 w-6 text-[#C4BDB4] mx-auto mb-2" />
                  <p className="text-sm text-[#6B7280]">No recorded price changes yet.</p>
                  <p className="text-xs text-[#9CA3AF] mt-1 max-w-md mx-auto">
                    A history entry is recorded each time this material's price is edited from the SKU
                    &amp; Costing grid. The trail starts building from the next price change.
                  </p>
                </div>
              ) : (
                <DataGrid<PriceHistoryEntry>
                  columns={historyColumns}
                  data={history}
                  keyField="id"
                  gridId="material-price-history"
                  emptyMessage="No price history."
                  stickyHeader
                  maxHeight="50vh"
                />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
