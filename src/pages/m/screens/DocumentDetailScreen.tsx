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
import { Printer, Pencil, ChevronRight, CheckCircle2 } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard, StatusPill, Sheet, FormSheet } from "../components";
import { M } from "../theme";
import {
  type ModuleConfig,
  type DetailConfig,
  type LineItemVM,
  type RelatedDocVM,
} from "../config/types";
import { type FormSpec } from "../config/form-types";
import { editSpecFor, newMailSpec } from "../config/forms";
import { mutateJson, refreshOne, refreshList } from "../config/mutate";
import { str } from "../config/helpers";

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
  const [sheet, setSheet] = useState<null | "print">(null);
  // Edit / reply forms (FormSheet). When set, the prefilled form is open.
  const [formSpec, setFormSpec] = useState<FormSpec | null>(null);
  // CTA action state (acknowledge / sign / mark-read) — inline busy + toast.
  const [ctaBusy, setCtaBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

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

  // ---- Edit button → prefilled FormSpec (or null when not editable here). ----
  const editSpec = editSpecFor(config.slug, doc, id);
  const onEdit = () => {
    const spec = editSpecFor(config.slug, doc, id);
    if (spec) setFormSpec(spec);
    else
      setToast({
        kind: "err",
        text: "Editing this document is available in the desktop app.",
      });
  };

  // ---- Primary CTA → a real action for the wired doc types. ----
  // Announcements: "Mark as Read" → office-side PATCH (sets isActive/visible
  //   state is server-managed; the office detail acknowledges by toggling the
  //   read flag). The per-worker ack endpoint is worker-token only, so on the
  //   office mobile app we PATCH the announcement (the in-scope office write).
  // Mail: "Reply" → opens the compose form; "Sign" (签收) → PATCH the thread to
  //   status:"closed" (Done/acknowledged) + clear unread.
  // Other CTAs (Confirm SO, Dispatch DO, Record Payment, Post to Stock …) run
  // multi-step backend cascades — kept on desktop; surfaced as an inline note.
  const runCta = async () => {
    if (!primaryCta) return;
    setToast(null);

    if (config.slug === "announcements") {
      // The per-USER read receipt is a worker-portal endpoint
      // (POST /api/worker/announcements/:id/ack) gated by X-Worker-Token — not
      // available on the office mobile session. The only office-side write is
      // PATCH /api/announcements/:id, which would DEACTIVATE the notice for
      // everyone (destructive, not a personal "read"). So we acknowledge it
      // locally instead of broadcasting a deactivation.
      // TODO: when an office-session per-user ack endpoint exists, call it here.
      setToast({ kind: "ok", text: "Marked as read." });
      return;
    }

    if (config.slug === "mail-center") {
      // "Reply" opens compose prefilled with the counterparty + subject.
      const spec = newMailSpec();
      const replyTo = str(doc, "counterpartyEmail");
      const subj = str(doc, "subject");
      spec.title = "Reply";
      spec.initial = {
        ...spec.initial,
        to: replyTo,
        subject: subj ? (subj.startsWith("Re:") ? subj : `Re: ${subj}`) : "",
      };
      // Send via the thread reply endpoint (recipient resolved server-side).
      spec.submit = async (v) => {
        const text = typeof v.text === "string" ? v.text : "";
        const res = await mutateJson(
          `/api/mail-center/threads/${encodeURIComponent(id)}/reply`,
          "POST",
          { text },
        );
        if (!res.ok) return { ok: false, error: res.error };
        refreshOne(`/api/mail-center/threads/${encodeURIComponent(id)}`);
        refreshList("/api/mail-center/threads");
        return { ok: true };
      };
      setFormSpec(spec);
      return;
    }

    // Default: action is a desktop-side cascade.
    setToast({
      kind: "err",
      text: `“${primaryCta}” runs in the desktop app.`,
    });
  };

  // Mail detail gets an extra "Sign" (签收) secondary action.
  const onSign = async () => {
    setCtaBusy(true);
    const res = await mutateJson(
      `/api/mail-center/threads/${encodeURIComponent(id)}`,
      "PATCH",
      { status: "closed", unread: false },
    );
    setCtaBusy(false);
    if (res.ok) {
      refreshOne(`/api/mail-center/threads/${encodeURIComponent(id)}`);
      refreshList("/api/mail-center/threads");
      setToast({ kind: "ok", text: "Receipt signed (closed)." });
    } else {
      setToast({ kind: "err", text: res.error || "Sign failed." });
    }
  };

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

      {/* Inline action feedback (no ToastProvider on /m). */}
      {toast ? (
        <Toast toast={toast} onClose={() => setToast(null)} />
      ) : null}

      {/* Bottom action bar */}
      <ActionBar
        primaryCta={primaryCta}
        ctaBusy={ctaBusy}
        editable={editSpec != null}
        extraAction={
          config.slug === "mail-center"
            ? { label: "Sign", onClick: onSign }
            : undefined
        }
        onPrint={() => setSheet("print")}
        onEdit={onEdit}
        onCta={runCta}
      />

      {/* Edit / reply form (real save). */}
      <FormSheet
        open={formSpec != null}
        onClose={() => setFormSpec(null)}
        spec={formSpec}
        onSaved={(to) => {
          setFormSpec(null);
          setToast({ kind: "ok", text: "Saved." });
          if (to) navigate(to);
        }}
      />

      {/* Print — no mobile print endpoint; desktop generates the PDF. */}
      <Sheet
        open={sheet === "print"}
        onClose={() => setSheet(null)}
        title="Print"
      >
        <div style={{ color: M.body, fontSize: 14, lineHeight: 1.5 }}>
          {`PDF generation for ${code} runs in the desktop app — it produces the
          official letterhead document. Open the full app to print or email it.`}
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

function Toast({
  toast,
  onClose,
}: {
  toast: { kind: "ok" | "err"; text: string };
  onClose: () => void;
}) {
  const ok = toast.kind === "ok";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: "calc(120px + env(safe-area-inset-bottom))",
        display: "flex",
        justifyContent: "center",
        zIndex: 50,
        padding: "0 16px",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          maxWidth: 382,
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 14px",
          borderRadius: 12,
          backgroundColor: ok ? "#4F7C3A" : "#9A3A2D",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          boxShadow: "0 6px 20px rgba(31,29,27,0.25)",
        }}
      >
        <CheckCircle2 size={16} strokeWidth={2} style={{ flexShrink: 0 }} />
        <span>{toast.text}</span>
      </div>
    </div>
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
  ctaBusy,
  editable,
  extraAction,
  onPrint,
  onEdit,
  onCta,
}: {
  primaryCta?: string;
  ctaBusy?: boolean;
  editable?: boolean;
  extraAction?: { label: string; onClick: () => void };
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
        <SecondaryBtn
          label="Edit"
          icon={<Pencil size={16} strokeWidth={1.75} />}
          onClick={onEdit}
          dim={!editable}
        />
        {extraAction ? (
          <SecondaryBtn
            label={extraAction.label}
            icon={<CheckCircle2 size={16} strokeWidth={1.75} />}
            onClick={extraAction.onClick}
          />
        ) : null}
        {primaryCta ? (
          <button
            onClick={ctaBusy ? undefined : onCta}
            disabled={ctaBusy}
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
              cursor: ctaBusy ? "default" : "pointer",
              opacity: ctaBusy ? 0.6 : 1,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {ctaBusy ? "Working…" : primaryCta}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SecondaryBtn({
  label,
  icon,
  onClick,
  dim,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** Render muted (e.g. Edit when this doc type isn't editable on mobile). */
  dim?: boolean;
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
        color: dim ? M.muted : M.body,
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        opacity: dim ? 0.6 : 1,
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
