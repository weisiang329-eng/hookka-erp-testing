// ===========================================================================
// SalesScreen — L1 Sales Orders list.
//
// Owner 2026-07-02 (v20 React reference `MobileSoList.tsx`): Sales is a bespoke
// list — status chips + a "count · revenue" summary strip + rich cards (Order →
// Expected date row, prominent total, cancelled rows dimmed). This rebuild
// matches the v20 look while keeping the REAL data + the existing sales power
// features (design "A": v20 look + keep function):
//   • same GET /api/sales-orders + the salesConfig source mapping (real fields
//     companySO / customerName / customerPO / totalSen / status…),
//   • KEEPS: ＋ create (FormSheet), Scan-PO OCR, and Filter/Sort sheet,
//   • summary strip shows count + revenue (sum of totalSen); "outstanding" is
//     omitted on the list because the list rows carry no paid figure — we don't
//     fabricate it (it IS shown on the detail, derived from linked payments).
//   • tap a card → /m/sales/:id (unchanged DocumentDetailScreen).
//
// ADDITIVE: replaces ONLY the /m/sales L1 view (CUSTOM_L1 in MobileLayout).
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SlidersHorizontal, Plus, FileSearch } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, StatusPill, FilterSheet, FormSheet, ScanPOSheet } from "../components";
import { M, M_ACCENT } from "../theme";
import { salesConfig } from "../config/modules";
import { newSalesOrderSpec, type SOCreatePrefill } from "../config/forms";
import { type FormSpec } from "../config/form-types";
import { type ActiveFilter } from "../config/types";
import {
  resolveStatus,
  STATUS_MAPS,
  str,
  num,
  dateOnly,
  money,
  applyFilters,
  applySort,
  activeFilterCount,
} from "../config/helpers";
import { useDebounced } from "../lib/use-debounced";

type Sort = { key: string; dir: "asc" | "desc" } | null;

// v20 status chips (adds "Cancelled" vs the old sub-tabs) → real SO statuses.
const CHIPS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "CONFIRMED", label: "Confirmed" },
  { key: "IN_PRODUCTION", label: "In Production" },
  { key: "READY_TO_SHIP", label: "Ready" },
  { key: "DELIVERED", label: "Delivered" },
  { key: "CANCELLED", label: "Cancelled" },
];

export function SalesScreen() {
  const navigate = useNavigate();
  const source = salesConfig.sources[0];

  const { data, loading, error } = useCachedJson<unknown>(source.url);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [chip, setChip] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, ActiveFilter>>({});
  const [sort, setSort] = useState<Sort>(source.defaultSort ?? null);
  const [createSpec, setCreateSpec] = useState<FormSpec | null>(null);
  const [scanOpen, setScanOpen] = useState(false);

  const allRows = useMemo(
    () => (data ? source.select(data) : []),
    [data, source],
  );

  const rows = useMemo(() => {
    const byChip = allRows.filter(
      (r) => chip === "all" || str(r, "status") === chip,
    );
    const filtered = applyFilters(byChip, source.columns, filters, dq);
    return applySort(filtered, source.columns, sort);
  }, [allRows, chip, source, filters, dq, sort]);

  // Per-chip counts + the summary strip (count · revenue over the searched set).
  const chipCounts = useMemo(() => {
    const searched = applyFilters(allRows, source.columns, filters, dq);
    const c: Record<string, number> = { all: searched.length };
    for (const r of searched) {
      const s = str(r, "status");
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [allRows, source, filters, dq]);

  const summary = useMemo(() => {
    let rev = 0;
    for (const r of rows) {
      if (str(r, "status") === "CANCELLED") continue;
      rev += num(r, "totalSen");
    }
    return { count: rows.length, rev };
  }, [rows]);

  const fCount = activeFilterCount(filters);

  return (
    <>
      <MobileHeader
        title="Sales Orders"
        onBack={() => navigate(-1)}
        trailing={
          <button
            onClick={() => setCreateSpec(newSalesOrderSpec())}
            aria-label="New Sales Order"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              border: "none",
              backgroundColor: M.taupe,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <Plus size={20} strokeWidth={2.2} />
          </button>
        }
      />

      {/* Search + Scan PO + Filter */}
      <div style={{ display: "flex", gap: 7, padding: "12px 18px 4px", minWidth: 0 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 13px",
            backgroundColor: M.card,
            border: `1px solid ${M.hairline}`,
            borderRadius: 12,
          }}
        >
          <Search size={18} strokeWidth={1.75} color={M.faint} />
          <input
            value={q}
            placeholder="Search SO · customer · PO · reference"
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: M.raisin,
            }}
          />
        </div>
        <button
          onClick={() => setScanOpen(true)}
          aria-label="Scan customer PO"
          style={{
            width: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: M.taupe,
            border: `1px solid ${M.taupe}`,
            borderRadius: 12,
            color: "#fff",
            cursor: "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <FileSearch size={19} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => setFilterOpen(true)}
          aria-label="Filter and sort"
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: fCount > 0 ? undefined : 44,
            padding: fCount > 0 ? "0 14px" : 0,
            backgroundColor: fCount > 0 ? M.taupe : M.card,
            border: `1px solid ${fCount > 0 ? M.taupe : M.hairline}`,
            borderRadius: 12,
            color: fCount > 0 ? "#fff" : M.ink,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <SlidersHorizontal size={19} strokeWidth={1.75} />
          {fCount > 0 ? fCount : ""}
        </button>
      </div>

      {/* Status chips */}
      <div
        style={{
          display: "flex",
          gap: 7,
          overflowX: "auto",
          padding: "10px 18px 4px",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {CHIPS.map((c) => {
          const on = chip === c.key;
          const n = chipCounts[c.key] ?? 0;
          return (
            <button
              key={c.key}
              onClick={() => setChip(c.key)}
              style={{
                height: 30,
                padding: "0 13px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
                flex: "none",
                cursor: "pointer",
                border: `1px solid ${on ? M.taupe : M.hairline}`,
                background: on ? M_ACCENT.gold.bg : M.card,
                color: on ? M.taupe : M.muted,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {c.label}
              {n > 0 ? (
                <span style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.7 }}>{n}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Summary strip — count · revenue */}
      {rows.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
            fontSize: 11.5,
            color: M.muted,
            padding: "10px 20px 2px",
          }}
        >
          <span>
            <b style={{ color: M.raisin }}>{summary.count}</b> orders
          </span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ fontWeight: 700, color: M.raisin }}>
            {money(summary.rev)} rev
          </span>
        </div>
      ) : null}

      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load sales orders." />
      ) : rows.length === 0 ? (
        <Msg
          text={
            q || chip !== "all"
              ? "No matching sales orders."
              : "No sales orders. Tap ＋ to create one."
          }
        />
      ) : (
        <div style={{ padding: "8px 18px 120px" }}>
          {rows.map((r) => (
            <SoCard
              key={str(r, "id", "companySO") || str(r, "companySO")}
              r={r}
              onClick={() =>
                navigate(
                  `/m/sales/${encodeURIComponent(str(r, "id", "companySO", "companySOId"))}`,
                )
              }
            />
          ))}
        </div>
      )}

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        columns={source.columns}
        filters={filters}
        sort={sort}
        onApply={(nextFilters, nextSort) => {
          setFilters(nextFilters);
          setSort(nextSort);
        }}
      />
      <FormSheet
        open={createSpec != null}
        onClose={() => setCreateSpec(null)}
        spec={createSpec}
        onSaved={(to) => {
          setCreateSpec(null);
          if (to) navigate(to);
        }}
      />
      <ScanPOSheet
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onResult={(extracted, sampleId) => {
          setScanOpen(false);
          const prefill: SOCreatePrefill = {
            customerId: extracted.customerId ?? "",
            customerPOId: extracted.customerPO ?? "",
            customerSOId: extracted.customerSO ?? extracted.yourRefNo ?? "",
            customerDeliveryDate: (extracted.deliveryDate ?? "").slice(0, 10),
            hookkaExpectedDD: (extracted.deliveryDate ?? "").slice(0, 10),
            items: extracted.items,
            // OCR accuracy: report the FINAL imported values on submit.
            scanSampleId: sampleId,
            scanRaw: extracted as unknown as Record<string, unknown>,
          };
          setCreateSpec(newSalesOrderSpec(prefill));
        }}
      />
    </>
  );
}

// ---- One SO card (v20 MobileSoList layout). --------------------------------
function SoCard({
  r,
  onClick,
}: {
  r: Record<string, unknown>;
  onClick: () => void;
}) {
  const code = str(r, "companySO", "companySOId") || "—";
  const customer = str(r, "customerName") || "—";
  const custPO = str(r, "customerPO", "customerPOId");
  const custSO = str(r, "customerSO", "customerSOId");
  const orderDate = dateOnly(r, "companySODate");
  const expected = dateOnly(r, "hookkaExpectedDD");
  const total = num(r, "totalSen");
  const cancelled = str(r, "status") === "CANCELLED";
  const status = resolveStatus(str(r, "status"), STATUS_MAPS.so);

  const sub = [custPO ? `PO ${custPO}` : "", custSO ? `Cust SO ${custSO}` : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        background: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 16,
        padding: "13px 15px",
        marginBottom: 11,
        cursor: "pointer",
        opacity: cancelled ? 0.55 : 1,
        boxShadow: "0 1px 0 rgba(31,29,27,.03),0 6px 20px -12px rgba(31,29,27,.14)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: M.taupe,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {code}
        </span>
        <StatusPill style={status.style} label={status.label} size="sm" />
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: M.raisin,
          marginTop: 8,
          letterSpacing: "-0.2px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {customer}
      </div>
      {sub ? (
        <div
          style={{
            fontSize: 12.5,
            color: M.muted,
            marginTop: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sub}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${M.divider}`,
        }}
      >
        <span style={{ fontSize: 11, color: M.faint, fontWeight: 600 }}>Order</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: M.ink }}>
          {orderDate || "—"}
        </span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#C4BDB2"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <span style={{ fontSize: 11, color: M.faint, fontWeight: 600 }}>Expected</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: M.ink }}>
          {expected || "—"}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 14,
            fontWeight: 800,
            color: M.raisin,
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {money(total)}
        </span>
      </div>
    </div>
  );
}

function Msg({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "40px 18px",
        textAlign: "center",
        color: M.muted,
        fontSize: 14,
      }}
    >
      {text}
    </div>
  );
}
