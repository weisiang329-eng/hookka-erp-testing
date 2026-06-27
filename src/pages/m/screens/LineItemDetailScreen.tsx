// ===========================================================================
// LineItemDetailScreen — the L3 line-item / material detail view.
//
// Reskinned (Wave 3) to match the design source's L3 "material detail": a
// header card (code + title + "Line item · <parent>"), a label/value field
// grid (item code, description, quantity, amount, category), and a "Used in"
// card that links back up to the parent document. A bottom action bar offers
// "View stock" → the Inventory module list (the closest real surface; there is
// no per-material stock detail route on /m yet).
//
// It re-uses the SAME single-doc endpoint as the L2 detail (already warm in the
// SWR cache, so no extra network cost), finds the tapped line item by id via
// the SAME config.detail.lineItems mapper, and shows its real fields. Nothing
// is fabricated: on-hand / rack / recent movements are NOT in the line-item
// payload, so they are omitted rather than invented.
//
// ADDITIVE: consumer of existing endpoints + Phase-1/2 primitives only.
// ===========================================================================
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronRight, FileText, Package } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard, StatusPill } from "../components";
import { M, SEMANTIC } from "../theme";
import { type ModuleConfig, type LineItemVM } from "../config/types";

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
  const eff = useMemo(
    () => (doc && detail ? (detail.resolve?.(doc, id) ?? detail) : detail),
    [doc, detail, id],
  );
  const items = useMemo(
    () => (doc && eff?.lineItems ? eff.lineItems(doc) : []),
    [doc, eff],
  );
  const item = items.find((it) => it.id === itemId) ?? null;
  const code = doc && eff ? eff.code(doc) : "";
  const parentTitle = doc && eff ? eff.title(doc) : "";

  // Field grid — mirrors the design source's item detail rows, populated from
  // the real LineItemVM the L2 mapper already produced.
  const fields = item ? buildFields(item) : [];

  return (
    <>
      <MobileHeader title="Line item" onBack={() => navigate(-1)} />

      {/* Breadcrumb (code › Line item) */}
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

      <div style={{ padding: "6px 18px 0", display: "grid", gap: 13 }}>
        {loading && !doc ? (
          <Msg text="Loading…" />
        ) : !item ? (
          <Msg text="Line item not found." />
        ) : (
          <>
            {/* Header card — design source: code (taupe), big title, sub. */}
            <MobileCard radius={18} style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                {item.subLine ? (
                  <span
                    style={{
                      color: M.taupe,
                      fontSize: 13,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.subLine}
                  </span>
                ) : (
                  <span />
                )}
                <StatusPill
                  style={categoryStyle(item.subLine)}
                  label={categoryLabel(item.subLine)}
                  size="sm"
                />
              </div>
              <div
                style={{
                  color: M.raisin,
                  fontSize: 21,
                  fontWeight: 800,
                  marginTop: 9,
                  letterSpacing: "-0.4px",
                  wordBreak: "break-word",
                }}
              >
                {item.title}
              </div>
              <div
                style={{ color: M.muted, fontSize: 13, marginTop: 3 }}
              >
                Line item{parentTitle ? ` · ${parentTitle}` : ""}
              </div>
            </MobileCard>

            {/* Field grid — design source: label (left) / value (right) rows. */}
            {fields.length ? (
              <MobileCard radius={18} style={{ padding: "4px 18px" }}>
                {fields.map((f, i) => {
                  const last = i === fields.length - 1;
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "13px 0",
                        borderBottom: last
                          ? "none"
                          : `1px solid ${M.divider}`,
                      }}
                    >
                      <span
                        style={{ color: M.muted, fontSize: 13, flexShrink: 0 }}
                      >
                        {f.label}
                      </span>
                      <span
                        style={{
                          color: M.raisin,
                          fontSize: 13.5,
                          fontWeight: 600,
                          textAlign: "right",
                          maxWidth: "60%",
                          fontVariantNumeric: "tabular-nums",
                          wordBreak: "break-word",
                        }}
                      >
                        {f.value || "—"}
                      </span>
                    </div>
                  );
                })}
              </MobileCard>
            ) : null}

            {/* Used in — design source: card linking back up to the parent. */}
            <div>
              <SectionHeading>Used in</SectionHeading>
              <MobileCard padded={false} radius={18} style={{ overflow: "hidden" }}>
                <div
                  onClick={() =>
                    navigate(`/m/${config.slug}/${encodeURIComponent(id)}`)
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/m/${config.slug}/${encodeURIComponent(id)}`);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 16px",
                    cursor: "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: "#F4EFE6",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "none",
                    }}
                  >
                    <FileText size={18} strokeWidth={1.75} color={M.taupe} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        color: M.raisin,
                        fontSize: 13.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {parentTitle || config.title}
                    </div>
                    <div
                      style={{
                        color: M.muted,
                        fontSize: 11.5,
                        marginTop: 2,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {code || config.title}
                    </div>
                  </div>
                  <ChevronRight
                    size={18}
                    strokeWidth={1.75}
                    color="#C4BDB2"
                    style={{ flexShrink: 0 }}
                  />
                </div>
              </MobileCard>
            </div>

            <div style={{ height: 12 }} />
          </>
        )}
      </div>

      {/* Bottom action bar — design source: a single primary CTA. */}
      {item ? (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "calc(56px + env(safe-area-inset-bottom))",
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 30,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 414,
              display: "flex",
              gap: 8,
              padding: "10px 12px",
              backgroundColor: M.paper,
              borderTop: `1px solid ${M.border}`,
              pointerEvents: "auto",
            }}
          >
            <button
              onClick={() => navigate("/m/inventory")}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "11px 0",
                borderRadius: 12,
                border: "none",
                backgroundColor: M.taupe,
                color: "#fff",
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Package size={17} strokeWidth={1.9} />
              View stock
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Build the field grid from the LineItemVM. The L2 mapper packs qty into meta1
// and amount into meta2; subLine holds the item/material code. We surface those
// plus a derived Category — never fabricating on-hand/rack/movement data the
// line-item payload doesn't carry.
// ---------------------------------------------------------------------------
function buildFields(item: LineItemVM): { label: string; value: React.ReactNode }[] {
  const out: { label: string; value: React.ReactNode }[] = [];
  if (item.subLine) out.push({ label: "Item code", value: item.subLine });
  out.push({ label: "Description", value: item.title });
  if (item.meta1)
    out.push({ label: item.meta1.label || "Quantity", value: item.meta1.value });
  if (item.meta2)
    out.push({ label: item.meta2.label || "Amount", value: item.meta2.value });
  out.push({ label: "Category", value: categoryLabel(item.subLine) });
  return out;
}

/** Derive a human category from the item-code prefix (design source rule). */
function categoryLabel(code: string | undefined): string {
  if (!code) return "Component";
  if (/^RM/i.test(code)) return "Raw material";
  if (/^FG/i.test(code)) return "Finished good";
  return "Component";
}

/** Map the derived category → a semantic pill style (reuses the brand map). */
function categoryStyle(code: string | undefined) {
  const c = categoryLabel(code);
  if (c === "Raw material") return SEMANTIC.WARNING;
  if (c === "Finished good") return SEMANTIC.SUCCESS;
  return SEMANTIC.NEUTRAL;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 700,
        color: M.ink,
        margin: "4px 4px 9px",
      }}
    >
      {children}
    </div>
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
