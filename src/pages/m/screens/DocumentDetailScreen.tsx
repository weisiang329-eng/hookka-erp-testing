// ===========================================================================
// DocumentDetailScreen — the ONE generic L2 detail screen for every document.
//
// Mirrors how Phase 2 made every L1 list generic: a single screen driven by a
// module's DetailConfig (src/pages/m/config/modules.ts → ModuleConfig.detail).
// Per the spec, every doc detail has the SAME structure:
//
//   • Breadcrumb (code · current section).
//   • Header card: code + status pill + title + a status-flow indicator
//     (the doc's lifecycle stages, current one highlighted — derived from the
//     repo's status enum order for that doc type).
//   • Field grid: the document's real fields/columns (dual-key reads inside
//     the config's value() extractors).
//   • Line-items list: tappable rows → an L3 ComingSoon (next phase).
//   • Related documents: cross-links (SO↔DO↔Invoice↔Customer) the payload
//     already exposes.
//   • Bottom action bar: Print · Edit · primary CTA — placeholder Sheets
//     (real Create/Edit is Phase 5).
//
// ADDITIVE: pure consumer of existing single-GET endpoints + Phase-1/2
// primitives. No backend, no desktop import, no fabricated data.
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Printer, Pencil, ChevronRight } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard, StatusPill, Sheet } from "../components";
import { M } from "../theme";
import {
  type ModuleConfig,
  type DetailConfig,
  type LineItemVM,
  type RelatedDocVM,
} from "../config/types";

export function DocumentDetailScreen({ config }: { config: ModuleConfig }) {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const detail = config.detail;

  // Defensive: this screen is only mounted when config.detail exists, but keep
  // a graceful fallback so a mis-wired route never white-screens.
  if (!detail) {
    return (
      <>
        <MobileHeader title={config.title} onBack={() => navigate(-1)} />
        <Msg text="No detail configured for this document type." />
      </>
    );
  }
  return <Inner config={config} detail={detail} id={id} />;
}

function Inner({
  config,
  detail,
  id,
}: {
  config: ModuleConfig;
  detail: DetailConfig;
  id: string;
}) {
  const navigate = useNavigate();
  const url = id ? detail.url(id) : null;
  const { data, loading, error } = useCachedJson<unknown>(url);
  const [sheet, setSheet] = useState<null | "print" | "edit" | "cta">(null);

  const doc = useMemo(
    () => (data ? detail.selectDoc(data, id) : null),
    [data, detail, id],
  );

  if (loading && !doc) {
    return (
      <>
        <MobileHeader title={config.title} onBack={() => navigate(-1)} />
        <Msg text="Loading…" />
      </>
    );
  }
  if (!doc) {
    return (
      <>
        <MobileHeader title={config.title} onBack={() => navigate(-1)} />
        <Msg
          text={
            error
              ? "Couldn’t load — pull to refresh or use the desktop app."
              : "Document not found."
          }
        />
      </>
    );
  }

  // Effective config — a slug hosting multiple doc types (e.g. Procurement
  // PO/GRN/PI) resolves the right sub-config once the doc is fetched.
  const eff = detail.resolve?.(doc, id) ?? detail;

  const code = eff.code(doc) || "—";
  const title = eff.title(doc) || "—";
  const status = eff.status?.(doc);
  const lineItems = eff.lineItems?.(doc) ?? [];
  const related = eff.relatedDocs?.(doc, data) ?? [];
  const primaryCta = eff.primaryCta?.(doc);

  // Group related docs under their `group` heading, preserving first-seen
  // order. Cheap pure transform — computed inline (placed after the early
  // returns, so it must NOT be a hook).
  const relatedGroups = groupRelated(related);

  return (
    <>
      <MobileHeader title={config.title} onBack={() => navigate(-1)} />

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
        <span style={{ color: M.taupe, fontWeight: 600 }}>{code}</span>
        <span style={{ margin: "0 6px" }}>›</span>
        <span>Overview</span>
      </div>

      <div style={{ padding: "6px 12px 0", display: "grid", gap: 12 }}>
        {/* Header card */}
        <MobileCard>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  color: M.taupe,
                  fontSize: 13,
                  fontWeight: 700,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: 0.2,
                }}
              >
                {code}
              </div>
              <div
                style={{
                  color: M.raisin,
                  fontSize: 18,
                  fontWeight: 700,
                  marginTop: 2,
                  wordBreak: "break-word",
                }}
              >
                {title}
              </div>
            </div>
            {status ? (
              <div style={{ flexShrink: 0 }}>
                <StatusPill style={status.style} label={status.label} />
              </div>
            ) : null}
          </div>

          {eff.flow && eff.flow.steps.length ? (
            <StatusFlow
              steps={eff.flow.steps}
              current={eff.flow.current(doc)}
            />
          ) : null}
        </MobileCard>

        {/* Field grid */}
        {eff.fields.length ? (
          <MobileCard>
            <SectionLabel>Details</SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px 10px",
                marginTop: 8,
              }}
            >
              {eff.fields.map((f, i) => (
                <div
                  key={i}
                  style={{ gridColumn: f.full ? "1 / -1" : undefined, minWidth: 0 }}
                >
                  <div style={{ color: M.muted, fontSize: 11, marginBottom: 2 }}>
                    {f.label}
                  </div>
                  <div
                    style={{
                      color: M.raisin,
                      fontSize: 14,
                      fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                      wordBreak: "break-word",
                    }}
                  >
                    {f.value(doc) || "—"}
                  </div>
                </div>
              ))}
            </div>
          </MobileCard>
        ) : null}

        {/* Line items */}
        {eff.lineItems ? (
          <MobileCard padded={false}>
            <div style={{ padding: "14px 16px 6px" }}>
              <SectionLabel>Items ({lineItems.length})</SectionLabel>
            </div>
            {lineItems.length === 0 ? (
              <div style={{ padding: "4px 16px 16px", color: M.muted, fontSize: 13 }}>
                No line items.
              </div>
            ) : (
              lineItems.map((it) => (
                <LineItemRow
                  key={it.id}
                  item={it}
                  onClick={() =>
                    navigate(
                      `/m/${config.slug}/${encodeURIComponent(id)}/item/${encodeURIComponent(it.id)}`,
                    )
                  }
                />
              ))
            )}
          </MobileCard>
        ) : null}

        {/* Related documents */}
        {relatedGroups.length ? (
          <MobileCard padded={false}>
            <div style={{ padding: "14px 16px 6px" }}>
              <SectionLabel>Related documents</SectionLabel>
            </div>
            {relatedGroups.map((g) => (
              <div key={g.group}>
                <div
                  style={{
                    padding: "8px 16px 4px",
                    fontSize: 11,
                    fontWeight: 700,
                    color: M.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  {g.group}
                </div>
                {g.items.map((r) => (
                  <RelatedRow
                    key={r.id}
                    rel={r}
                    onClick={r.href ? () => navigate(r.href as string) : undefined}
                  />
                ))}
              </div>
            ))}
          </MobileCard>
        ) : null}

        <div style={{ height: 12 }} />
      </div>

      {/* Bottom action bar */}
      <ActionBar
        primaryCta={primaryCta}
        onPrint={() => setSheet("print")}
        onEdit={() => setSheet("edit")}
        onCta={() => setSheet("cta")}
      />

      {/* Placeholder sheets (real actions land in Phase 5). */}
      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={
          sheet === "print"
            ? "Print"
            : sheet === "edit"
              ? "Edit"
              : primaryCta || "Action"
        }
      >
        <div style={{ color: M.body, fontSize: 14, lineHeight: 1.5 }}>
          {sheet === "print"
            ? `Printing ${code} arrives in a later phase. Use the desktop app to print this document for now.`
            : sheet === "edit"
              ? `Editing ${code} arrives in a later phase. The desktop app can edit this document.`
              : `“${primaryCta}” arrives in a later phase.`}
        </div>
        <button
          onClick={() => setSheet(null)}
          style={{
            marginTop: 16,
            width: "100%",
            padding: "12px 0",
            borderRadius: 12,
            border: "none",
            backgroundColor: M.taupe,
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Got it
        </button>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Status-flow indicator — the doc's lifecycle stages, current one highlighted.
// Steps come from the repo's status enum order for that doc type (config.flow).
// The current step + everything before it render filled (taupe); later steps
// render muted. An unknown current status (e.g. CANCELLED / ON_HOLD, which sit
// outside the linear flow) just leaves every step un-highlighted.
// ---------------------------------------------------------------------------
function StatusFlow({
  steps,
  current,
}: {
  steps: { key: string; label: string }[];
  current: string;
}) {
  const idx = steps.findIndex(
    (s) => s.key.toUpperCase() === (current || "").toUpperCase(),
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        marginTop: 14,
        overflowX: "auto",
        gap: 0,
        WebkitOverflowScrolling: "touch",
      }}
    >
      {steps.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        const isCurrent = i === idx;
        return (
          <div
            key={s.key}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              flex: "1 0 auto",
              minWidth: 52,
              position: "relative",
            }}
          >
            {/* Connector to the previous dot */}
            {i > 0 ? (
              <div
                style={{
                  position: "absolute",
                  top: 7,
                  right: "50%",
                  width: "100%",
                  height: 2,
                  backgroundColor: done ? M.taupe : M.border,
                }}
              />
            ) : null}
            <div
              style={{
                position: "relative",
                zIndex: 1,
                width: isCurrent ? 16 : 14,
                height: isCurrent ? 16 : 14,
                borderRadius: 9999,
                backgroundColor: done ? M.taupe : M.card,
                border: `2px solid ${done ? M.taupe : M.border}`,
                marginTop: isCurrent ? 0 : 1,
              }}
            />
            <div
              style={{
                marginTop: 5,
                fontSize: 9.5,
                lineHeight: 1.2,
                textAlign: "center",
                color: isCurrent ? M.raisin : M.muted,
                fontWeight: isCurrent ? 700 : 500,
              }}
            >
              {s.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LineItemRow({
  item,
  onClick,
}: {
  item: LineItemVM;
  onClick: () => void;
}) {
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
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 16px",
        borderTop: `1px solid ${M.border}`,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: M.raisin,
            fontSize: 14,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </div>
        {item.subLine ? (
          <div
            style={{
              color: M.muted,
              fontSize: 12,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.subLine}
          </div>
        ) : null}
      </div>
      {item.meta1 || item.meta2 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
            flexShrink: 0,
          }}
        >
          {[item.meta1, item.meta2].map((m, i) =>
            m ? (
              <div key={i} style={{ textAlign: "right" }}>
                <div style={{ color: M.muted, fontSize: 10 }}>{m.label}</div>
                <div
                  style={{
                    color: M.raisin,
                    fontSize: 13,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.value}
                </div>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
      <ChevronRight size={18} strokeWidth={1.75} color={M.muted} style={{ flexShrink: 0 }} />
    </div>
  );
}

function RelatedRow({
  rel,
  onClick,
}: {
  rel: RelatedDocVM;
  onClick?: () => void;
}) {
  const interactive = typeof onClick === "function";
  return (
    <div
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 16px",
        borderTop: `1px solid ${M.border}`,
        cursor: interactive ? "pointer" : "default",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: M.taupe,
            fontSize: 13,
            fontWeight: 700,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {rel.code}
        </div>
        {rel.subLine ? (
          <div style={{ color: M.muted, fontSize: 12, marginTop: 2 }}>
            {rel.subLine}
          </div>
        ) : null}
      </div>
      {rel.status ? (
        <StatusPill style={rel.status.style} label={rel.status.label} size="sm" />
      ) : null}
      {interactive ? (
        <ChevronRight size={18} strokeWidth={1.75} color={M.muted} style={{ flexShrink: 0 }} />
      ) : null}
    </div>
  );
}

function ActionBar({
  primaryCta,
  onPrint,
  onEdit,
  onCta,
}: {
  primaryCta?: string;
  onPrint: () => void;
  onEdit: () => void;
  onCta: () => void;
}) {
  return (
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
        <SecondaryBtn label="Print" icon={<Printer size={16} strokeWidth={1.75} />} onClick={onPrint} />
        <SecondaryBtn label="Edit" icon={<Pencil size={16} strokeWidth={1.75} />} onClick={onEdit} />
        <button
          onClick={onCta}
          style={{
            flex: 1.4,
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
          {primaryCta || "Actions"}
        </button>
      </div>
    </div>
  );
}

function SecondaryBtn({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: "11px 0",
        borderRadius: 12,
        border: `1px solid ${M.border}`,
        backgroundColor: M.card,
        color: M.body,
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: M.muted,
        textTransform: "uppercase",
        letterSpacing: 0.4,
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

function groupRelated(
  related: RelatedDocVM[],
): { group: string; items: RelatedDocVM[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, RelatedDocVM[]>();
  for (const r of related) {
    if (!byGroup.has(r.group)) {
      byGroup.set(r.group, []);
      order.push(r.group);
    }
    byGroup.get(r.group)!.push(r);
  }
  return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
}
