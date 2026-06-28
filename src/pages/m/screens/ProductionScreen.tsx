// ===========================================================================
// ProductionScreen — the custom L1 Production "Kanban" screen.
//
// Owner 2026-06-28 design v12: Production is no longer a generic list (which
// reads as a wall of identical rows); it's a board grouped by the production
// department the PO currently sits in. Per-dept row:
//   header (colored dot + dept name + count badge)
//   horizontal-scroll strip of 210-px job cards (SO code · status pill ·
//   product · Qty + due · progress bar).
// Tap a card → /m/production/:id (the existing DocumentDetailScreen — driven
// by productionConfig.detail in src/pages/m/config/modules.ts; nothing about
// the detail screen changes).
//
// REAL DATA — single GET /api/production-orders, grouped client-side by
// `currentDepartment`. Same endpoint productionConfig uses, so no new backend
// and no second fetch.
//
// Progress per PO is derived from the embedded `jobCards`: completed cards ÷
// total. A PO with no job cards shows a flat 0% bar (not fabricated).
//
// ADDITIVE: this screen replaces ONLY the /m/production L1 view (registered
// in MobileLayout's CUSTOM_L1 map). All other production routes — the L2
// detail at /m/production/:id, the More-menu "Production Orders" entry, and
// the desktop / dashboard-b production data — are untouched.
// ===========================================================================
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, StatusPill } from "../components";
import { M, M_ACCENT } from "../theme";
import { resolveStatus, STATUS_MAPS, str, num, dateOnly } from "../config/helpers";

// ---- API response shape (subset of /api/production-orders output) ----
type JobCard = {
  id?: string;
  departmentCode?: string;
  status?: string;
  progress?: number;
};
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
  quantity?: number;
  targetEndDate?: string;
  currentDepartment?: string;
  jobCards?: JobCard[];
};
type Resp = { success?: boolean; data?: PO[] };

// Production depts in lifecycle order. The design source lists them in the
// same order; mismatched/unknown department codes fall into an "Other" group
// at the end (real fact-of-data — not fabricated).
const DEPTS: { code: string; label: string }[] = [
  { code: "FAB_CUT", label: "Fab Cut" },
  { code: "FAB_SEW", label: "Fab Sew" },
  { code: "FOAM", label: "Foam" },
  { code: "WOOD_CUT", label: "Wood Cut" },
  { code: "FRAMING", label: "Framing" },
  { code: "WEBBING", label: "Webbing" },
  { code: "UPHOLSTERY", label: "Upholstery" },
  { code: "PACKING", label: "Packing" },
];

// Accent cycle for the dept dot. The dc12 source uses a small palette and
// cycles it across departments — reuse our existing M_ACCENT keys so colours
// are consistent with the rest of /m.
const DEPT_ACCENTS: (keyof typeof M_ACCENT)[] = [
  "gold",
  "info",
  "moss",
  "warning",
  "plum",
  "danger",
  "gold",
  "info",
];

function progressPctOf(po: PO): number {
  const jcs = po.jobCards;
  if (!Array.isArray(jcs) || jcs.length === 0) return 0;
  const done = jcs.filter((jc) => str(jc, "status") === "COMPLETED").length;
  return Math.round((done / jcs.length) * 100);
}

export function ProductionScreen() {
  const navigate = useNavigate();
  // Lightweight fetch — minimal fields + jobCards. Same query the Home
  // Pending-Delivery card uses, so the cache may already be warm.
  const { data, loading, error } = useCachedJson<Resp>(
    "/api/production-orders?fields=minimal&include=jobCards",
  );

  const groups = useMemo(() => {
    const all = data?.success ? data.data ?? [] : [];
    // Exclude terminal POs (completed/cancelled) — a board view shows
    // in-flight work. The desktop dashboard's plant-load uses the same cut.
    const live = all.filter((po) => {
      const s = str(po, "status");
      return s !== "COMPLETED" && s !== "CANCELLED";
    });
    const byDept = new Map<string, PO[]>();
    for (const po of live) {
      const dept = str(po, "currentDepartment") || "OTHER";
      const arr = byDept.get(dept) ?? [];
      arr.push(po);
      byDept.set(dept, arr);
    }
    // Ordered render: known depts in lifecycle order, then any unknown depts
    // (rare — old POs missing a current dept) under "Other".
    const ordered: { code: string; label: string; jobs: PO[]; accent: keyof typeof M_ACCENT }[] = [];
    DEPTS.forEach((d, i) => {
      const jobs = byDept.get(d.code) ?? [];
      ordered.push({ ...d, jobs, accent: DEPT_ACCENTS[i % DEPT_ACCENTS.length] });
      byDept.delete(d.code);
    });
    for (const [code, jobs] of byDept) {
      ordered.push({ code, label: code, jobs, accent: "plum" });
    }
    return ordered;
  }, [data]);

  return (
    <>
      <MobileHeader title="Production" />
      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load production orders." />
      ) : (
        <div style={{ padding: "2px 0 120px" }}>
          {groups.every((g) => g.jobs.length === 0) ? (
            <Msg text="No live production orders." />
          ) : (
            groups.map((g) => {
              if (g.jobs.length === 0) return null;
              const accent = M_ACCENT[g.accent];
              return (
                <div key={g.code} style={{ marginBottom: 6 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "10px 20px 8px",
                    }}
                  >
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 3,
                        background: accent.fg,
                        flex: "none",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: M.raisin,
                      }}
                    >
                      {g.label}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: M.muted,
                        background: M.card,
                        border: `1px solid ${M.border}`,
                        padding: "1px 8px",
                        borderRadius: 20,
                      }}
                    >
                      {g.jobs.length}
                    </span>
                  </div>
                  <div
                    className="scrollarea"
                    style={{
                      display: "flex",
                      gap: 11,
                      overflowX: "auto",
                      overflowY: "hidden",
                      padding: "4px 18px 8px",
                      WebkitOverflowScrolling: "touch",
                    }}
                  >
                    {g.jobs.map((po) => (
                      <JobCardTile
                        key={po.id}
                        po={po}
                        accent={accent.fg}
                        onClick={() =>
                          navigate(`/m/production/${encodeURIComponent(po.id)}`)
                        }
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </>
  );
}

// ---- Single job-card tile (210px wide, design source spec). ------------------

function JobCardTile({
  po,
  accent,
  onClick,
}: {
  po: PO;
  accent: string;
  onClick: () => void;
}) {
  const so =
    str(po, "companySO", "companySOId", "customerSO") || str(po, "poNo") || "—";
  const product =
    str(po, "productName", "productCode") || str(po, "customerName") || "—";
  const qty = num(po, "quantity");
  const due = dateOnly(po, "targetEndDate");
  const pct = progressPctOf(po);
  const status = resolveStatus(str(po, "status"), STATUS_MAPS.production);

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
        width: 210,
        flex: "none",
        background: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 15,
        padding: "13px 14px",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: M.taupe,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {so}
        </span>
        <StatusPill style={status.style} label={status.label} size="sm" />
      </div>
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: M.raisin,
          marginTop: 8,
          lineHeight: 1.3,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {product}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 10,
        }}
      >
        <span style={{ fontSize: 11.5, color: M.muted }}>
          Qty <b style={{ color: M.ink }}>{qty}</b>
        </span>
        <span style={{ fontSize: 11, color: M.muted }}>{due || "—"}</span>
      </div>
      <div
        style={{
          marginTop: 9,
          height: 5,
          background: "#F0EBE0",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: accent,
            borderRadius: 4,
          }}
        />
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
