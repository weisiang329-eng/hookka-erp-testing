// ===========================================================================
// ProductionScreen — L1 Production list.
//
// Owner 2026-07-02 (v20 React reference `MobileProduction.tsx`): Production is
// a VERTICAL LIST with a department filter-chip row + a per-card stage-pipeline
// bar, NOT the old horizontal Kanban board. This rebuild matches the v20 look
// 1:1 while keeping Hookka's REAL data:
//   • v20's mock has 5 stages; Hookka's real pipeline has 8 departments, so the
//     chips + the pipeline bar use the real 8 depts (design "A": v20 look, real
//     function — never fabricate the mock's simpler pipeline).
//   • one GET /api/production-orders (minimal, no jobCards — this board reads
//     only currentDepartment + status), grouped/filtered client-side. Same
//     endpoint productionConfig.detail uses → no new backend.
//   • tap a card → /m/production/:id (unchanged DocumentDetailScreen).
//
// ADDITIVE: replaces ONLY the /m/production L1 view (CUSTOM_L1 in MobileLayout).
// The L2 detail, the More-menu entry, and desktop/dashboard data are untouched.
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, StatusPill } from "../components";
import { M, M_ACCENT } from "../theme";
import { resolveStatus, STATUS_MAPS, str, num, dateOnly } from "../config/helpers";
import { useDebounced } from "../lib/use-debounced";

type PO = {
  id: string;
  poNo?: string;
  status?: string;
  productCode?: string;
  productName?: string;
  customerName?: string;
  companySO?: string;
  companySOId?: string;
  customerSO?: string;
  picName?: string;
  quantity?: number;
  targetEndDate?: string;
  currentDepartment?: string;
};
type Resp = { success?: boolean; data?: PO[] };

// Real 8-department pipeline in lifecycle order (v20's stage bar, real depts).
const DEPTS: { code: string; label: string }[] = [
  { code: "FAB_CUT", label: "Fab Cut" },
  { code: "FAB_SEW", label: "Fab Sew" },
  { code: "FOAM_CUTTING", label: "Foam Cutting" },
  { code: "FOAM", label: "Foam Bonding" },
  { code: "WOOD_CUT", label: "Wood Cut" },
  { code: "FRAMING", label: "Framing" },
  { code: "WEBBING", label: "Webbing" },
  { code: "UPHOLSTERY", label: "Upholstery" },
  { code: "PACKING", label: "Packing" },
];
const CHIPS = [{ code: "all", label: "All" }, ...DEPTS];

/** Position of the PO's current department in the pipeline (-1 if unknown). */
function stageIndexOf(po: PO): number {
  const dept = str(po, "currentDepartment");
  return DEPTS.findIndex((d) => d.code === dept);
}

export function ProductionScreen() {
  const navigate = useNavigate();
  // Dedicated board endpoint (perf 2026-07-14): returns ONLY the live set
  // (status NOT IN COMPLETED/CANCELLED — this board's own filter, applied
  // server-side) slimmed to the ~11 fields the board renders + customerSO.
  // Measured live: 1921→378 rows, ~1.6MB→108KB decoded, byte-identical (0 diffs
  // vs the old client live-filter incl. customerSO). The client STILL runs its
  // search + per-dept counts over the WHOLE returned set (all 378 live rows are
  // loaded) so nothing becomes unfindable. Snapshot-cached + serve-stale.
  const { data, loading, error } = useCachedJson<Resp>(
    "/api/production-orders/board",
  );
  const [query, setQuery] = useState("");
  const dquery = useDebounced(query);
  const [chip, setChip] = useState("all");

  const rows = useMemo(() => {
    const all = data?.success ? data.data ?? [] : [];
    const q = dquery.trim().toLowerCase();
    return all.filter((po) => {
      const s = str(po, "status");
      // Live board — exclude terminal work (matches the desktop plant view).
      if (s === "COMPLETED" || s === "CANCELLED") return false;
      if (chip !== "all" && str(po, "currentDepartment") !== chip) return false;
      if (!q) return true;
      const hay = [
        str(po, "poNo"),
        str(po, "companySO"),
        str(po, "customerSO"),
        str(po, "productCode"),
        str(po, "productName"),
        str(po, "customerName"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, dquery, chip]);

  // Per-chip counts (over the live, searched set — ignoring the dept filter).
  const counts = useMemo(() => {
    const all = data?.success ? data.data ?? [] : [];
    const q = dquery.trim().toLowerCase();
    const live = all.filter((po) => {
      const s = str(po, "status");
      if (s === "COMPLETED" || s === "CANCELLED") return false;
      if (!q) return true;
      const hay = [
        str(po, "poNo"), str(po, "companySO"), str(po, "customerSO"),
        str(po, "productCode"), str(po, "productName"), str(po, "customerName"),
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
    const c: Record<string, number> = { all: live.length };
    // (counts recompute on the debounced query — see dep array below)
    for (const po of live) {
      const d = str(po, "currentDepartment") || "";
      c[d] = (c[d] ?? 0) + 1;
    }
    return c;
  }, [data, dquery]);

  return (
    <>
      <MobileHeader title="Production Orders" />

      {/* Search */}
      <div style={{ padding: "12px 18px 4px" }}>
        <div
          style={{
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
            value={query}
            placeholder="Search PRD · product · SO · customer"
            onChange={(e) => setQuery(e.target.value)}
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
      </div>

      {/* Department chips (All + 8 real depts) */}
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
          const on = chip === c.code;
          const n = counts[c.code] ?? 0;
          return (
            <button
              key={c.code}
              onClick={() => setChip(c.code)}
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
                <span style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.7 }}>
                  {n}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load production orders." />
      ) : rows.length === 0 ? (
        <Msg
          text={
            query || chip !== "all"
              ? "No matching production orders."
              : "No live production orders."
          }
        />
      ) : (
        <div style={{ padding: "8px 18px 120px" }}>
          {rows.map((po) => (
            <JobRow
              key={po.id}
              po={po}
              onClick={() =>
                navigate(`/m/production/${encodeURIComponent(po.id)}`)
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---- One production-order card (v20 layout: code+badge, product, sub, stage
// pipeline bar, current-stage label + PIC/due). ------------------------------
function JobRow({ po, onClick }: { po: PO; onClick: () => void }) {
  const code = str(po, "poNo", "companySO", "companySOId") || "—";
  const product = str(po, "productName", "productCode") || "—";
  const soRef = str(po, "companySO", "companySOId", "customerSO");
  const customer = str(po, "customerName");
  const qty = num(po, "quantity");
  const pic = str(po, "picName");
  const due = dateOnly(po, "targetEndDate");
  const si = stageIndexOf(po);
  const stageLabel = si >= 0 ? DEPTS[si].label : "—";
  const status = resolveStatus(str(po, "status"), STATUS_MAPS.production);

  const sub = [soRef, customer, qty ? `×${qty}` : ""]
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
        {product}
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

      {/* Stage pipeline bar — 8 segments, filled up to the current dept. */}
      <div style={{ display: "flex", gap: 3, marginTop: 12 }}>
        {DEPTS.map((d, i) => (
          <div
            key={d.code}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: si >= 0 && i <= si ? M.taupe : "#EAE3D6",
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 6,
          fontSize: 11,
        }}
      >
        <span style={{ color: M.taupe, fontWeight: 700 }}>{stageLabel}</span>
        <span style={{ color: M.muted }}>
          {pic ? `PIC ${pic}` : due ? `Due ${due}` : ""}
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
