// ===========================================================================
// PendingLeaveRequests — the Employees "Pending requests" approve/reject panel.
//
// New design (erp-redesign-new) adds an approve/reject card to the Employees
// Attendance tab. This is REAL: it reads PENDING rows from GET /api/leaves and
// writes the decision back via PUT /api/leaves { id, status, approvedBy } — the
// same office-side leave-approval flow the desktop uses.
//
// ADDITIVE: imported only by the Employees module config's topPanel.
// ===========================================================================
import { useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { getCurrentUser } from "@/lib/auth";
import { MobileCard, StatusPill } from "./index";
import { M } from "../theme";
import { resolveStatus, PAYMENT_STATUS_MAP } from "../config/helpers";
import { mutateJson, refreshList } from "../config/mutate";

type Leave = {
  id: string;
  workerId?: string;
  workerName?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  status?: string;
  reason?: string;
  approvedBy?: string;
};
type LeavesResp = { success?: boolean; data?: Leave[] };

const LEAVE_STATUS_MAP = {
  PENDING: PAYMENT_STATUS_MAP.PENDING,
  APPROVED: PAYMENT_STATUS_MAP.APPROVED,
  REJECTED: PAYMENT_STATUS_MAP.MISMATCH, // danger tint
};

export function PendingLeaveRequests() {
  const user = getCurrentUser();
  const approver = user?.displayName || "Office";
  // Pull pending requests only (the panel is an action queue).
  const { data, refresh } = useCachedJson<LeavesResp>(
    "/api/leaves?status=PENDING",
  );
  const pending = useMemo(() => data?.data ?? [], [data]);

  // Local optimistic decision map so a decided card shows its outcome before
  // the refetch lands. Keyed by leave id → "APPROVED" | "REJECTED".
  const [decided, setDecided] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (id: string, status: "APPROVED" | "REJECTED") => {
    if (busy) return;
    setBusy(id);
    const res = await mutateJson("/api/leaves", "PUT", {
      id,
      status,
      approvedBy: approver,
    });
    setBusy(null);
    if (res.ok) {
      setDecided((p) => ({ ...p, [id]: status }));
      refreshList("/api/leaves");
      refresh();
    }
  };

  // Nothing pending and nothing just-decided → render nothing (no empty card).
  const visible = pending.filter((r) => !decided[r.id]);
  const justDecided = pending.filter((r) => decided[r.id]);
  if (visible.length === 0 && justDecided.length === 0) return null;

  const rows = [...visible, ...justDecided];

  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          margin: "0 2px 11px",
        }}
      >
        <ClipboardCheck size={17} strokeWidth={1.75} color={M.taupe} />
        <span style={{ fontSize: 15, fontWeight: 800, color: M.raisin }}>
          Pending requests
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((r) => {
          const outcome = decided[r.id];
          const st = resolveStatus(outcome || r.status || "PENDING", LEAVE_STATUS_MAP);
          const range = [r.startDate, r.endDate]
            .filter(Boolean)
            .map((d) => (d || "").slice(0, 10))
            .filter((d, i, a) => a.indexOf(d) === i)
            .join(" → ");
          return (
            <MobileCard key={r.id} radius={15} style={{ padding: "14px 15px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: M.taupe,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r.id}
                </span>
                <StatusPill style={st.style} label={st.label} size="sm" />
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: M.raisin,
                  marginTop: 8,
                }}
              >
                {r.workerName || r.workerId || "—"}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: M.ink,
                  marginTop: 4,
                  fontWeight: 600,
                }}
              >
                {r.type || "Leave request"}
                {r.days ? ` · ${r.days} day${r.days === 1 ? "" : "s"}` : ""}
              </div>
              {(range || r.reason) ? (
                <div style={{ fontSize: 12, color: M.muted, marginTop: 2 }}>
                  {[r.reason, range].filter(Boolean).join(" · ")}
                </div>
              ) : null}

              {outcome ? (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 11,
                    borderTop: `1px solid ${M.divider}`,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: M.taupe,
                  }}
                >
                  {outcome === "APPROVED" ? "Approved" : "Rejected"} by {approver}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    onClick={() => decide(r.id, "REJECTED")}
                    disabled={busy === r.id}
                    style={{
                      flex: 1,
                      height: 38,
                      border: "1px solid #E8B2A1",
                      background: M.card,
                      borderRadius: 10,
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: "#9A3A2D",
                      cursor: busy === r.id ? "default" : "pointer",
                      opacity: busy === r.id ? 0.6 : 1,
                      fontFamily: "inherit",
                    }}
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => decide(r.id, "APPROVED")}
                    disabled={busy === r.id}
                    style={{
                      flex: 1,
                      height: 38,
                      border: "none",
                      background: "#4F7C3A",
                      borderRadius: 10,
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: "#fff",
                      cursor: busy === r.id ? "default" : "pointer",
                      opacity: busy === r.id ? 0.6 : 1,
                      fontFamily: "inherit",
                    }}
                  >
                    Approve
                  </button>
                </div>
              )}
            </MobileCard>
          );
        })}
      </div>
    </div>
  );
}
