// ===========================================================================
// ProductionDetailScreen — L2 Production Order detail.
//
// Owner 2026-07-02 (v20 `MobileProductionDetail.tsx`): a big stage-pipeline
// stepper + linked SO + Order Info + History. Rebuilt to that look with REAL
// data (8-department pipeline, GET /api/production-orders/:id).
//
// SAFETY: advancing/holding a production order mutates live factory state
// (job cards, cascades) — [[feedback_protect_completed_work]] "production locks
// are inviolate". The old /m detail exposed NO such button, and this back-office
// screen keeps it that way: stage changes happen on the shop floor (worker scan)
// or the desktop Production board. The action bar deep-links there instead of
// firing a risky mobile PUT.
// ===========================================================================
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { StatusPill } from "../components";
import { M } from "../theme";
import { resolveStatus, STATUS_MAPS, str, num, dateOnly } from "../config/helpers";

type RawRow = Record<string, unknown>;
type Envelope = { success?: boolean; data?: RawRow };
type AuditResp = { data?: RawRow[] };

// Real 8-department pipeline (v20 stepper, real depts).
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

function arr(v: unknown): RawRow[] {
  return Array.isArray(v) ? (v as RawRow[]) : [];
}

export function ProductionDetailScreen() {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const url = `/api/production-orders/${encodeURIComponent(id)}`;
  const { data, loading, error } = useCachedJson<Envelope>(url);
  const { data: auditRaw } = useCachedJson<AuditResp>(
    id ? `/api/audit-events?resource=production-orders&resourceId=${encodeURIComponent(id)}` : null,
  );
  const [showDesk, setShowDesk] = useState(false);

  const doc = data?.data ?? null;
  if (loading && !doc) return <Center text="Loading…" />;
  if (error && !doc) return <Center text="Couldn’t load this production order." />;
  if (!doc) return <Center text="Production order not found." />;

  const status = str(doc, "status");
  const pill = resolveStatus(status, STATUS_MAPS.production);
  const si = DEPTS.findIndex((d) => d.code === str(doc, "currentDepartment"));
  const audit = arr(auditRaw?.data);
  // Real per-department job cards (GET /api/production-orders/:id → jobCards[]):
  // departmentCode · status · completedDate · dueDate · pic1Name/pic2Name. The
  // stepper only lights from the currentDepartment scalar; this surfaces the
  // real "who + when" per stage the design shows (no fabricated timeline).
  const jobCards = arr(doc.jobCards).slice().sort((a, b) => {
    const ai = DEPTS.findIndex((d) => d.code === str(a, "departmentCode"));
    const bi = DEPTS.findIndex((d) => d.code === str(b, "departmentCode"));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const soId = str(doc, "salesOrderId");
  const soNo = str(doc, "companySO", "companySOId", "customerSO");

  const info: [string, string][] = [
    ["Product", str(doc, "productName", "productCode") || "—"],
    ["Quantity", `×${num(doc, "quantity")}`],
    ["Customer", str(doc, "customerName") || "—"],
    ["Customer PO", str(doc, "customerPO", "customerPOId") || "—"],
    ["Customer SO", str(doc, "customerSO", "customerSOId") || "—"],
    ["Reference", str(doc, "reference") || "—"],
    ["PIC", str(doc, "picName", "pic") || "—"],
    ["QC Status", str(doc, "qcStatus", "qc") || "—"],
    ["Expected DD", dateOnly(doc, "targetEndDate") || "—"],
  ];

  return (
    <div style={{ paddingBottom: 92 }}>
      {/* Header */}
      <div
        style={{
          background: M.card,
          padding: "14px 16px 12px",
          borderBottom: `1px solid ${M.divider}`,
          position: "sticky",
          top: 0,
          zIndex: 5,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button
            onClick={() => navigate(-1)}
            style={{ background: "none", border: "none", color: M.taupe, fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}
          >
            ‹ Production
          </button>
          <StatusPill style={pill.style} label={pill.label} size="sm" />
        </div>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".13em", textTransform: "uppercase", color: M.taupe, marginTop: 7 }}>
          {str(doc, "poNo")}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: M.ink, letterSpacing: "-0.3px", marginTop: 1 }}>
          {str(doc, "productName", "productCode") || "—"}
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {/* Stage stepper — 8 depts */}
        <div
          style={{
            background: M.card,
            border: `1px solid ${M.border}`,
            borderRadius: 16,
            padding: "16px 12px 14px",
            marginBottom: 11,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start" }}>
            {DEPTS.map((d, i) => {
              const done = si >= 0 && i < si;
              const active = i === si;
              return (
                <div key={d.code} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", position: "relative" }}>
                  {i > 0 ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        right: "50%",
                        width: "100%",
                        height: 2,
                        background: si >= 0 && i <= si ? M.taupe : "#EAE3D6",
                      }}
                    />
                  ) : null}
                  <div
                    style={{
                      position: "relative",
                      zIndex: 1,
                      width: 25,
                      height: 25,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      fontWeight: 800,
                      background: done ? M.taupe : active ? "#C9A961" : M.card,
                      color: done || active ? "#fff" : M.faint,
                      border: done || active ? "none" : `2px solid #EAE3D6`,
                    }}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <div style={{ fontSize: 8, fontWeight: active ? 700 : 500, color: active ? M.ink : M.faint, marginTop: 5, lineHeight: 1.15 }}>
                    {d.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Stage Progress — real job-card completion per department */}
        {jobCards.length > 0 ? (
          <Card title="Stage Progress">
            <div style={{ padding: "4px 15px 8px" }}>
              {jobCards.map((jc, i) => {
                const deptCode = str(jc, "departmentCode");
                const label = DEPTS.find((d) => d.code === deptCode)?.label || deptCode || "Stage";
                const st = str(jc, "status") || "—";
                const done = /COMPLET|DONE/i.test(st);
                const completed = dateOnly(jc, "completedDate");
                const due = dateOnly(jc, "dueDate");
                const when = completed ? completed : due ? `due ${due}` : "";
                const pic = [str(jc, "pic1Name"), str(jc, "pic2Name")].filter(Boolean).join(", ");
                return (
                  <div
                    key={str(jc, "id") || i}
                    style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${M.divider}`, alignItems: "baseline" }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: M.ink }}>{label}</div>
                      {pic ? <div style={{ fontSize: 11, color: M.faint, marginTop: 2 }}>{pic}</div> : null}
                    </div>
                    <div style={{ textAlign: "right", flex: "none" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: done ? "#4F7C3A" : M.muted }}>{st}</div>
                      {when ? <div style={{ fontSize: 11, color: M.faint, marginTop: 2 }}>{when}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ) : null}

        {/* Linked SO */}
        {soId || soNo ? (
          <button
            onClick={() => navigate(`/m/sales/${encodeURIComponent(soId || soNo)}`)}
            style={{
              display: "flex",
              width: "100%",
              justifyContent: "space-between",
              alignItems: "center",
              background: M.card,
              border: `1px solid ${M.border}`,
              borderRadius: 16,
              padding: "13px 15px",
              marginBottom: 11,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span style={{ fontSize: 12.5, color: M.muted }}>Sales Order</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: M.taupe }}>{soNo || "—"} ›</span>
          </button>
        ) : null}

        {/* Order Info */}
        <Card title="Order Info">
          <div style={{ padding: "4px 15px 8px" }}>
            {info.map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${M.divider}` }}>
                <span style={{ fontSize: 12, color: M.muted }}>{l}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: M.ink, textAlign: "right" }}>{v}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* History */}
        {audit.length > 0 ? (
          <Card title="History">
            <div style={{ padding: "4px 15px 10px" }}>
              {audit.slice(0, 30).map((h, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "11px 0", borderTop: i ? `1px solid ${M.divider}` : "none", alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: M.muted, width: 78, flex: "none" }}>
                    {dateOnly(h, "createdAt", "ts", "timestamp") || ""}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: M.ink, flex: 1 }}>
                    {str(h, "action", "eventLabel", "summary", "message") || "—"}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: M.faint, flex: "none" }}>
                    {str(h, "actor", "userName")}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      {/* Action bar — SAFE: stage changes happen on the shop floor / desktop
          board (production state is inviolate here). */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          background: M.card,
          borderTop: `1px solid ${M.divider}`,
          padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
          display: "flex",
          gap: 9,
        }}
      >
        <button
          onClick={() => navigate(-1)}
          style={{ flex: 1, height: 48, border: `1px solid ${M.border}`, borderRadius: 12, background: M.card, color: M.body, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
        >
          Back
        </button>
        {status !== "COMPLETED" && status !== "CANCELLED" ? (
          <button
            onClick={() => setShowDesk(true)}
            style={{ flex: 1.3, height: 48, border: "none", borderRadius: 12, background: M.taupe, color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            Change stage
          </button>
        ) : null}
      </div>

      {showDesk ? (
        <div
          onClick={() => setShowDesk(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(31,29,27,.4)", zIndex: 60, display: "flex", alignItems: "flex-end" }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", background: M.paper, borderRadius: "26px 26px 0 0", padding: "18px 18px 26px" }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "#D8D0C2", margin: "0 auto 14px" }} />
            <div style={{ fontSize: 15, fontWeight: 800, color: M.ink }}>Change production stage</div>
            <div style={{ fontSize: 12.5, color: M.muted, marginTop: 8, lineHeight: 1.5 }}>
              Stage moves are done on the shop floor (worker scans the job card) or
              on the desktop Production board — so the job-card cascade stays
              correct. Open the desktop board to change this order’s stage.
            </div>
            <button
              onClick={() => navigate("/production")}
              style={{ width: "100%", height: 48, marginTop: 16, border: "none", borderRadius: 12, background: M.taupe, color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              Open Production board
            </button>
            <button
              onClick={() => setShowDesk(false)}
              style={{ width: "100%", height: 46, marginTop: 8, border: `1px solid ${M.border}`, borderRadius: 12, background: M.card, color: M.body, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        background: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 16,
        marginBottom: 11,
        overflow: "hidden",
        boxShadow: "0 1px 0 rgba(31,29,27,.03),0 6px 20px -12px rgba(31,29,27,.14)",
      }}
    >
      <div style={{ padding: "12px 15px", borderBottom: `1px solid ${M.divider}` }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: M.muted }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Center({ text }: { text: string }) {
  return <div style={{ padding: "60px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>;
}
