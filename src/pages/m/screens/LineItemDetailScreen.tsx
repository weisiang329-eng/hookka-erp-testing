// ===========================================================================
// LineItemDetailScreen — minimal L3 view for a tapped line item.
//
// Phase 3 scope (per spec): "tappable rows (→ L3 in a later phase; for now
// route to a ComingSoon L3 or a minimal item view)". This is the minimal item
// view: it re-uses the SAME single-doc endpoint as the L2 detail (already warm
// in the SWR cache, so no extra network cost), finds the tapped line item by
// id, and shows its fields. Breadcrumb shows the trail (CODE › Line item) and
// the back button pops one level (back to the L2 detail).
//
// Full material drill-down ("Used in" → back to its order, payslip earnings,
// stock-movement detail) is a later phase.
//
// ADDITIVE: consumer of existing endpoints + Phase-1/2 primitives only.
// ===========================================================================
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard } from "../components";
import { M } from "../theme";
import { type ModuleConfig } from "../config/types";

export function LineItemDetailScreen({ config }: { config: ModuleConfig }) {
  const navigate = useNavigate();
  const { id = "", itemId = "" } = useParams();
  const detail = config.detail;
  const url = id && detail ? detail.url(id) : null;
  const { data, loading } = useCachedJson<unknown>(url);

  const doc = useMemo(
    () => (data && detail ? detail.selectDoc(data, id) : null),
    [data, detail, id],
  );
  const items = useMemo(
    () => (doc && detail?.lineItems ? detail.lineItems(doc) : []),
    [doc, detail],
  );
  const item = items.find((it) => it.id === itemId) ?? null;
  const code = doc && detail ? detail.code(doc) : "";

  return (
    <>
      <MobileHeader title="Line item" onBack={() => navigate(-1)} />

      {/* Breadcrumb */}
      <div
        style={{
          padding: "8px 14px 2px",
          fontSize: 12,
          color: M.muted,
          fontVariantNumeric: "tabular-nums",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span
          onClick={() => navigate(-1)}
          style={{ color: M.taupe, fontWeight: 600, cursor: "pointer" }}
        >
          {code || "Document"}
        </span>
        <span style={{ margin: "0 6px" }}>›</span>
        <span>Line item</span>
      </div>

      <div style={{ padding: "6px 12px 0" }}>
        {loading && !doc ? (
          <Msg text="Loading…" />
        ) : !item ? (
          <Msg text="Line item not found." />
        ) : (
          <MobileCard>
            <div
              style={{
                color: M.raisin,
                fontSize: 18,
                fontWeight: 700,
                wordBreak: "break-word",
              }}
            >
              {item.title}
            </div>
            {item.subLine ? (
              <div
                style={{
                  color: M.taupe,
                  fontSize: 13,
                  fontWeight: 600,
                  marginTop: 2,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                }}
              >
                {item.subLine}
              </div>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px 10px",
                marginTop: 16,
              }}
            >
              {[item.meta1, item.meta2].map((m, i) =>
                m ? (
                  <div key={i}>
                    <div style={{ color: M.muted, fontSize: 11, marginBottom: 2 }}>
                      {m.label}
                    </div>
                    <div
                      style={{
                        color: M.raisin,
                        fontSize: 16,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {m.value}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
          </MobileCard>
        )}
      </div>
    </>
  );
}

function Msg({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "60px 24px",
        textAlign: "center",
        color: M.muted,
        fontSize: 14,
      }}
    >
      {text}
    </div>
  );
}
