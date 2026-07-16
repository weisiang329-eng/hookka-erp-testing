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
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Printer,
  Pencil,
  ChevronRight,
  CheckCircle2,
  Check,
  Package,
  FileText,
  Copy,
  ArrowDownToLine,
  ArrowUpFromLine,
  PackageCheck,
  Receipt,
  QrCode,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard, StatusPill, Sheet, FormSheet, QrModal } from "../components";
import { M, M_ACCENT } from "../theme";
import {
  type ModuleConfig,
  type DetailConfig,
  type LineItemVM,
  type RelatedDocVM,
  type SubDocRow,
} from "../config/types";
import { type FormSpec } from "../config/form-types";
import { editSpecFor, newMailSpec, recordPaymentSpec, stockAdjustmentSpec } from "../config/forms";
import { PodSheet } from "../components/PodSheet";
import { GrnReceiveSheet } from "../components/GrnReceiveSheet";
import type { ProofOfDelivery } from "@/types";
import { mutateJson, refreshOne, refreshList } from "../config/mutate";
import { str } from "../config/helpers";

/** Leading-glyph map for the "Convert document" action buttons. */
const EXTRA_ACTION_ICONS: Record<string, LucideIcon> = {
  "package-check": PackageCheck,
  receipt: Receipt,
  "file-text": FileText,
  copy: Copy,
};

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
  // Optional extra fetches (dc12: employee detail joins attendance + payslip
  // into the same screen). Fixed at TWO named slots so hook count is constant
  // across renders (rules-of-hooks). Each slot's URL is `null` when the
  // config didn't declare it or the slot's url-builder returned null.
  const extraAUrl = id && detail.extraFetches?.a ? detail.extraFetches.a.url(id) : null;
  const extraBUrl = id && detail.extraFetches?.b ? detail.extraFetches.b.url(id) : null;
  const extraCUrl = id && detail.extraFetches?.c ? detail.extraFetches.c.url(id) : null;
  const { data: extraAData } = useCachedJson<unknown>(extraAUrl);
  const { data: extraBData } = useCachedJson<unknown>(extraBUrl);
  const { data: extraCData } = useCachedJson<unknown>(extraCUrl);
  // Audit history — CHANGELOG B.7 "History audit". When the config declares
  // auditResource, fetch /api/audit-events?resource=X&resourceId=Y.
  const auditResource = id && detail.auditResource ? detail.auditResource(id) : null;
  const auditUrl = auditResource
    ? `/api/audit-events?resource=${encodeURIComponent(auditResource)}&resourceId=${encodeURIComponent(id)}`
    : null;
  const { data: auditData } = useCachedJson<{
    success?: boolean;
    data?: { id: string; action: string; actorUserName?: string; ts: string }[];
  }>(auditUrl);
  // Doc-level file attachments — when the config declares an
  // attachmentsResource, fetch its files list + render an upload section.
  const attResource = id && detail.attachmentsResource ? detail.attachmentsResource(id) : null;
  const filesUrl = attResource
    ? `/api/files?resourceType=${encodeURIComponent(attResource.type)}&resourceId=${encodeURIComponent(attResource.id)}`
    : null;
  const { data: filesData } = useCachedJson<{
    success?: boolean;
    data?: { id: string; filename: string; contentType?: string; sizeBytes?: number; uploadedAt?: string }[];
  }>(filesUrl);
  const [sheet, setSheet] = useState<null | "print">(null);
  // Edit / reply forms (FormSheet). When set, the prefilled form is open.
  const [formSpec, setFormSpec] = useState<FormSpec | null>(null);
  // Proof-of-delivery capture sheet (delivery "Mark Delivered").
  const [podOpen, setPodOpen] = useState(false);
  // Goods-receipt sheet (procurement PO "Receive (GRN)").
  const [grnOpen, setGrnOpen] = useState(false);
  // CTA action state (acknowledge / sign / mark-read) — inline busy + toast.
  const [ctaBusy, setCtaBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  // QR modal open state (dc12: doc detail has a Barcode + Open QR card).
  const [qrOpen, setQrOpen] = useState(false);
  // File-upload state (when the config declares an attachmentsResource).
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const doc = useMemo(
    () => (data ? detail.selectDoc(data, id) : null),
    [data, detail, id],
  );

  // Effective config — a slug hosting multiple doc types (e.g. Procurement
  // PO/GRN/PI) resolves the right sub-config once the doc is fetched.
  const eff = useMemo(
    () => (doc ? (detail.resolve?.(doc, id) ?? detail) : detail),
    [detail, doc, id],
  );

  // ---- Barcode + QR card (dc12) — order-type docs only. ----
  // The "barcode" is a decorative bar pattern derived deterministically from
  // the doc code (NOT a real CODE128 — that would need a barcode lib + space
  // for the encoded data; the dc12 design source itself uses 40 styled spans).
  // The real scannable target is the QR (Open QR button), which encodes the
  // mobile detail URL so a phone-camera scan opens this page on another
  // device. These hooks MUST run before the early returns below (rules-of-
  // hooks), so we read `code` from the eff/doc pair instead of the post-early-
  // return destructured `code`. Inline-evaluating eff.code(doc) keeps the
  // value identical across the two reads.
  const docCode = doc ? eff.code(doc) || "—" : "—";
  const isOrderDoc = ["sales", "delivery", "procurement", "invoices"].includes(
    config.slug,
  );
  const bars = useMemo(() => {
    const seed = docCode || "X";
    const out: { w: number; dark: boolean }[] = [];
    for (let i = 0; i < 40; i++) {
      const cc = seed.charCodeAt(i % seed.length) || 7;
      const w = ((cc + i * 13) % 6) + 1; // 1–6 px wide
      const dark = (cc + i) % 3 !== 0;
      out.push({ w, dark });
    }
    return out;
  }, [docCode]);
  const docQrChoices = useMemo(() => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return [
      {
        label: docCode,
        code: docCode,
        value: `${origin}/m/${config.slug}/${encodeURIComponent(id)}`,
      },
    ];
  }, [docCode, config.slug, id]);

  // ---- Derive ALL view data in ONE memo (perf — the L2 freeze fix). ----
  // PREVIOUSLY every config mapper (lineItems / relatedDocs / subDocLists /
  // kvSections / body / darkStat …) ran inline on EVERY render. They each
  // allocate fresh arrays of objects, so each of the many re-renders this
  // screen sees — useCachedJson seeds cached data then swaps in the network
  // result; plus toast / sheet / formSpec / ctaBusy state changes — re-ran the
  // whole heavy derivation tree AND handed every child a new array identity,
  // forcing the entire subtree to re-render. On a heavy doc (an SO/DO/PI with
  // dozens of line items, each carrying specs + customization chips) that work
  // compounds into a visible hang/freeze. Memoising on [eff, doc, data] does it
  // once per fetch instead of once per keystroke/state-change, and keeps array
  // identities stable so React can skip untouched rows.
  //
  // NOTE: this hook MUST run before the early returns below (rules-of-hooks),
  // so it guards `!doc` internally and returns empty placeholders in that case.
  const derived = useMemo(() => {
    if (!doc) {
      return {
        code: "—",
        title: "—",
        status: undefined as ReturnType<NonNullable<DetailConfig["status"]>>,
        lineItems: [] as LineItemVM[],
        relatedGroups: [] as { group: string; items: RelatedDocVM[] }[],
        primaryCta: undefined as string | undefined,
        darkStat: undefined as ReturnType<NonNullable<DetailConfig["darkStat"]>>,
        bodyParas: [] as string[],
        kvSections: [] as NonNullable<ReturnType<NonNullable<DetailConfig["kvSections"]>>>,
        netPay: undefined as ReturnType<NonNullable<DetailConfig["netPay"]>>,
        subDocLists: [] as NonNullable<ReturnType<NonNullable<DetailConfig["subDocLists"]>>>,
        extraActions: [] as NonNullable<ReturnType<NonNullable<DetailConfig["extraActions"]>>>,
      };
    }
    return {
      code: eff.code(doc) || "—",
      title: eff.title(doc) || "—",
      status: eff.status?.(doc),
      lineItems: eff.lineItems?.(doc) ?? [],
      relatedGroups: groupRelated(eff.relatedDocs?.(doc, data) ?? []),
      primaryCta: eff.primaryCta?.(doc),
      extraActions: eff.extraActions?.(doc, id) ?? [],
      // Optional special sections (rack hero / body / payslip / sub-doc lists)
      // — each computed only when the config supplies it AND it has content.
      darkStat: eff.darkStat?.(doc),
      bodyParas: (eff.body?.(doc) ?? []).filter((p) => p && p.trim()),
      kvSections: (eff.kvSections?.(doc) ?? []).filter((s) => s.rows.length),
      netPay: eff.netPay?.(doc),
      subDocLists: (() => {
        const base = (
          eff.subDocLists?.(doc, data, {
            ...(eff.extraFetches?.a
              ? { [eff.extraFetches.a.key]: extraAData }
              : {}),
            ...(eff.extraFetches?.b
              ? { [eff.extraFetches.b.key]: extraBData }
              : {}),
            ...(eff.extraFetches?.c
              ? { [eff.extraFetches.c.key]: extraCData }
              : {}),
          },
          // openForm callback — used by row.onClick handlers (e.g. Customer
          // Hub Edit) to open a FormSheet with the spec.
          setFormSpec,
          ) ?? []
        ).filter((l) => l.rows.length || l.emptyText);

        // Audit History — automatic sub-list when auditResource is set.
        const events = (auditData?.data ?? []) as { id: string; action: string; actorUserName?: string; ts: string }[];
        if (events.length > 0) {
          base.push({
            title: `History · ${events.length}`,
            rows: events.slice(0, 30).map((e) => ({
              id: e.id,
              title: e.action,
              subLine: [e.actorUserName || "—", new Date(e.ts).toLocaleString()].join(" · "),
              icon: "file-text" as const,
            })),
          });
        }
        return base;
      })(),
    };
  }, [eff, doc, data, id, extraAData, extraBData, extraCData, auditData]);

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

  const {
    code,
    title,
    status,
    lineItems,
    relatedGroups,
    primaryCta,
    darkStat,
    bodyParas,
    kvSections,
    netPay,
    subDocLists,
    extraActions,
  } = derived;
  const showActionBar = !eff.hideActionBar;

  // ---- Edit button → prefilled FormSpec (or null when not editable here). ----
  // Built once per render and reused by onEdit (avoid a second build on tap).
  const editSpec = editSpecFor(config.slug, doc, id);
  const onEdit = () => {
    if (editSpec) setFormSpec(editSpec);
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

    // Announcements detail is read-only on mobile (hideActionBar) — it shows
    // the read-receipt roster; there is no office-user "Mark as Read" write
    // (announcement_acks is worker-keyed), so no CTA branch here.

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

    if (config.slug === "inventory" && primaryCta === "Reduce Stock") {
      // Remove-only raw-material stock adjustment (FIFO-valued).
      setFormSpec(stockAdjustmentSpec(doc, id));
      return;
    }

    if (config.slug === "procurement" && primaryCta === "Receive (GRN)") {
      // Receive goods against this PO — opens the per-line receive sheet.
      setGrnOpen(true);
      return;
    }

    if (config.slug === "delivery" && primaryCta === "Mark Delivered") {
      // Open POD capture (signature + photos) — submit handled by onSubmit below.
      setPodOpen(true);
      return;
    }

    if (config.slug === "invoices" && primaryCta === "Record Payment") {
      // Record a customer payment — same PUT the desktop invoice detail uses.
      setFormSpec(recordPaymentSpec(doc, id));
      return;
    }

    if (config.slug === "servicecases") {
      // Case lifecycle advance — a clean single endpoint (PUT
      // /api/service-cases/:id/status). "Start Work" → IN_PROGRESS, "Close
      // Case" → CLOSED. The backend enforces the allowed transitions, so a
      // bad jump surfaces its error rather than us guessing.
      const next = primaryCta === "Start Work" ? "IN_PROGRESS" : "CLOSED";
      setCtaBusy(true);
      const res = await mutateJson(
        `/api/service-cases/${encodeURIComponent(id)}/status`,
        "PUT",
        { status: next },
      );
      setCtaBusy(false);
      if (res.ok) {
        refreshOne(`/api/service-cases/${encodeURIComponent(id)}`);
        refreshList("/api/service-cases");
        setToast({
          kind: "ok",
          text: next === "CLOSED" ? "Case closed." : "Case marked in progress.",
        });
      } else {
        setToast({ kind: "err", text: res.error || "Status update failed." });
      }
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

      <div style={{ padding: "6px 18px 0", display: "grid", gap: 13 }}>
        {/* Header card — design source: code + status, big title, status flow. */}
        <MobileCard radius={18} style={{ padding: 18 }}>
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
                color: M.taupe,
                fontSize: 13,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {code}
            </span>
            {status ? (
              <div style={{ flexShrink: 0 }}>
                <StatusPill style={status.style} label={status.label} />
              </div>
            ) : null}
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
            {title}
          </div>

          {eff.flow && eff.flow.steps.length ? (
            <StatusFlow
              steps={eff.flow.steps}
              current={eff.flow.current(doc)}
            />
          ) : null}
        </MobileCard>

        {/* Dark hero stat — design source: rack hero on warehouse detail. */}
        {darkStat ? <DarkStatCard stat={darkStat} /> : null}

        {/* Field grid — design source: label (left) / value (right) rows with
            an inner hairline between each. */}
        {eff.fields.length ? (
          <MobileCard radius={18} style={{ padding: "4px 18px" }}>
            {eff.fields.map((f, i) => {
              const last = i === eff.fields.length - 1;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "13px 0",
                    borderBottom: last ? "none" : `1px solid ${M.divider}`,
                  }}
                >
                  <span style={{ color: M.muted, fontSize: 13, flexShrink: 0 }}>
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
                    {f.value(doc) || "—"}
                  </span>
                </div>
              );
            })}
          </MobileCard>
        ) : null}

        {/* Barcode + Open-QR card — dc12 design v12: order-type docs (SO/DO/
            PO/GRN/PI/Invoice) carry a scannable QR linking to this mobile
            detail page; bars are decorative (40 spans, deterministic widths
            from the doc code). Skipped for non-order docs. */}
        {isOrderDoc ? (
          <MobileCard radius={16} style={{ padding: "14px 16px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#A89F8D",
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    marginBottom: 8,
                  }}
                >
                  Barcode
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "stretch",
                    gap: 1,
                    height: 46,
                    overflow: "hidden",
                  }}
                >
                  {bars.map((b, i) => (
                    <span
                      key={i}
                      style={{
                        width: b.w,
                        background: b.dark ? "#1F1D1B" : "#fff",
                        flex: "none",
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#4D4630",
                    letterSpacing: 2,
                    marginTop: 6,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {code}
                </div>
              </div>
              <div
                onClick={() => setQrOpen(true)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setQrOpen(true);
                  }
                }}
                style={{
                  flex: "none",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  padding: "6px 10px",
                  borderRadius: 12,
                  border: "1px solid #E2DDD8",
                  background: "#FAF8F4",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <QrCode size={34} strokeWidth={1.75} color="#6B5C32" />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#6B5C32",
                  }}
                >
                  Open QR
                </span>
              </div>
            </div>
          </MobileCard>
        ) : null}

        {/* Body paragraphs — design source: announcement / mail message body. */}
        {bodyParas.length ? (
          <MobileCard radius={18} style={{ padding: 18 }}>
            {bodyParas.map((p, i) => (
              <p
                key={i}
                style={{
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: "#3A352C",
                  margin: i === bodyParas.length - 1 ? 0 : "0 0 12px",
                  whiteSpace: "pre-line",
                }}
              >
                {p}
              </p>
            ))}
          </MobileCard>
        ) : null}

        {/* Key-value sections — design source: payslip Earnings / Deductions. */}
        {kvSections.map((s) => (
          <div key={s.title}>
            <SectionHeading>{s.title}</SectionHeading>
            <MobileCard radius={18} style={{ padding: "4px 18px" }}>
              {s.rows.map((r, i) => {
                const last = i === s.rows.length - 1;
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "12px 0",
                      borderBottom: last ? "none" : `1px solid ${M.divider}`,
                    }}
                  >
                    <span style={{ color: M.muted, fontSize: 13 }}>
                      {r.label}
                    </span>
                    <span
                      style={{
                        color: s.negative ? "#9A3A2D" : M.raisin,
                        fontSize: 13.5,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {r.value}
                    </span>
                  </div>
                );
              })}
            </MobileCard>
          </div>
        ))}

        {/* Convert document — design source v10: PO → GRN / PO → Invoice. The
            buttons deep-link to the desktop convert flows (real conversions). */}
        {extraActions.length > 0 ? (
          <div>
            <SectionHeading>Convert document</SectionHeading>
            <div style={{ display: "flex", gap: 8 }}>
              {extraActions.map((a) => {
                const Icon = EXTRA_ACTION_ICONS[a.icon ?? "file-text"];
                return (
                  <button
                    key={a.label}
                    onClick={() => {
                      if (a.formSpec) {
                        // Open the FormSheet with the returned spec — used for
                        // Log Hours and other mobile-side create/edit flows.
                        setFormSpec(a.formSpec());
                      } else if (a.onClick) {
                        // Pass navigate so onClick can route after its async work
                        void a.onClick(navigate);
                      } else if (a.to) {
                        navigate(a.to);
                      }
                    }}
                    style={{
                      flex: 1,
                      height: 44,
                      borderRadius: 12,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 7,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                      WebkitTapHighlightColor: "transparent",
                      border: a.primary ? "none" : `1px solid ${M.hairline}`,
                      background: a.primary ? M.taupe : M.card,
                      color: a.primary ? "#fff" : M.ink,
                    }}
                  >
                    <Icon size={16} strokeWidth={1.9} />
                    {a.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Net pay — design source: payslip dark net-pay band. */}
        {netPay ? (
          <div
            style={{
              background: M.raisin,
              borderRadius: 18,
              padding: "16px 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, color: "#C9BD9A", fontWeight: 600 }}>
              {netPay.label}
            </span>
            <span
              style={{
                fontSize: 20,
                fontWeight: 800,
                color: "#F0ECE9",
                letterSpacing: "-0.3px",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {netPay.value}
            </span>
          </div>
        ) : null}

        {/* Files — doc-level attachments (dc12 design v12 paperclip). Only
            shown when the config declares an attachmentsResource (SO / DO /
            PO / GRN / PI / Invoice today). Upload via the hidden file input;
            the list re-fetches after the POST resolves. Backend gates the
            actual storage behind Supabase config — a 503 just leaves the
            list empty + the upload toast surfaces the error message. */}
        {attResource ? (
          <div>
            <SectionHeading>Files</SectionHeading>
            <MobileCard padded={false} radius={18} style={{ overflow: "hidden" }}>
              {/* Upload button row */}
              <div
                style={{
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: `1px solid ${M.divider}`,
                }}
              >
                <span style={{ fontSize: 13, color: M.body }}>
                  {(filesData?.data ?? []).length} attached
                </span>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 13,
                    fontWeight: 700,
                    color: uploading ? M.muted : "#fff",
                    background: uploading ? M.hairline : M.taupe,
                    border: "none",
                    borderRadius: 10,
                    padding: "8px 14px",
                    cursor: uploading ? "default" : "pointer",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {uploading ? "Uploading…" : "Upload"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  // Accept photos + PDFs + common doc types (matches the
                  // desktop /api/files ALLOWED_MIME set).
                  accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setUploadErr(null);
                    setUploading(true);
                    try {
                      const fd = new FormData();
                      fd.append("file", f);
                      fd.append("resourceType", attResource.type);
                      fd.append("resourceId", attResource.id);
                      const resp = await fetch("/api/files", {
                        method: "POST",
                        body: fd,
                        credentials: "include",
                      });
                      const json = (await resp.json()) as { success?: boolean; error?: string };
                      if (!resp.ok || !json.success) {
                        setUploadErr(json.error || `Upload failed (${resp.status})`);
                        setToast({ kind: "err", text: json.error || "Upload failed" });
                      } else {
                        setToast({ kind: "ok", text: "Uploaded." });
                        // Refresh the files list cache so the new file appears.
                        refreshOne(filesUrl as string);
                      }
                    } catch (err) {
                      const msg = (err as Error).message || "Upload failed";
                      setUploadErr(msg);
                      setToast({ kind: "err", text: msg });
                    } finally {
                      setUploading(false);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }
                  }}
                />
              </div>
              {/* Files list */}
              {(filesData?.data ?? []).length === 0 ? (
                <div style={{ padding: 16, color: M.muted, fontSize: 13 }}>
                  {uploadErr || "No files yet."}
                </div>
              ) : (
                (filesData?.data ?? []).map((f, i) => (
                  <a
                    key={f.id}
                    href={`/api/files/${encodeURIComponent(f.id)}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      borderTop: i === 0 ? "none" : `1px solid ${M.divider}`,
                      color: M.raisin,
                      textDecoration: "none",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    <FileText size={18} color={M.taupe} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: M.raisin,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {f.filename}
                      </div>
                      <div style={{ fontSize: 11.5, color: M.muted }}>
                        {f.sizeBytes ? `${Math.round(f.sizeBytes / 1024)} KB · ` : ""}
                        {f.uploadedAt
                          ? new Date(f.uploadedAt).toLocaleDateString()
                          : ""}
                      </div>
                    </div>
                    <ChevronRight size={17} color="#C4BDB2" />
                  </a>
                ))
              )}
            </MobileCard>
          </div>
        ) : null}

        {/* Sub-document lists — design source: payslips under an employee,
            rack contents + recent movements under a rack. */}
        {subDocLists.map((list) => (
          <div key={list.title}>
            <SectionHeading>{list.title}</SectionHeading>
            <MobileCard padded={false} radius={18} style={{ overflow: "hidden" }}>
              {list.rows.length === 0 ? (
                <div style={{ padding: 16, color: M.muted, fontSize: 13 }}>
                  {list.emptyText}
                </div>
              ) : (
                list.rows.map((r, i) => (
                  <SubDocRowView
                    key={r.id}
                    row={r}
                    first={i === 0}
                    onClick={
                      r.onClick
                        ? r.onClick
                        : r.href
                          ? () => navigate(r.href as string)
                          : undefined
                    }
                  />
                ))
              )}
            </MobileCard>
          </div>
        ))}

        {/* Line items — design source: section heading above an overflow-hidden
            card; each row has a gold icon tile + name/spec + qty/amount. */}
        {eff.lineItems ? (
          <div>
            <SectionHeading>Line items</SectionHeading>
            <MobileCard
              padded={false}
              radius={18}
              style={{ overflow: "hidden" }}
            >
              {lineItems.length === 0 ? (
                <div
                  style={{ padding: "16px", color: M.muted, fontSize: 13 }}
                >
                  No line items.
                </div>
              ) : (
                lineItems.map((it, i) => (
                  <LineItemRow
                    key={it.id}
                    item={it}
                    first={i === 0}
                    onClick={() =>
                      navigate(
                        `/m/${config.slug}/${encodeURIComponent(id)}/item/${encodeURIComponent(it.id)}`,
                      )
                    }
                  />
                ))
              )}
            </MobileCard>
          </div>
        ) : null}

        {/* Document relationship — CHANGELOG #6. Visual flow:
            current doc highlighted, related docs grouped + linked with
            connectors. Mirrors desktop /src/components/ui/so-document-
            relationship.tsx as a vertical stacked flow (suited for
            mobile width). */}
        {relatedGroups.length ? (
          <div>
            <SectionHeading>Document relationship</SectionHeading>
            <MobileCard padded={false} radius={18} style={{ overflow: "hidden", padding: "16px 8px" }}>
              {/* Current document — yellow-highlighted node */}
              <div
                style={{
                  margin: "0 auto 10px",
                  maxWidth: 280,
                  textAlign: "center",
                  padding: "10px 14px",
                  background: "#F0EAD8",
                  border: `2px solid ${M.taupe}`,
                  borderRadius: 12,
                  color: M.raisin,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {code} (this doc)
              </div>
              {relatedGroups.map((g) => (
                <div key={g.group}>
                  {/* Vertical connector line */}
                  <div
                    style={{
                      width: 2,
                      height: 18,
                      background: M.taupe,
                      margin: "0 auto",
                    }}
                  />
                  {/* Group label */}
                  <div
                    style={{
                      textAlign: "center",
                      fontSize: 10,
                      fontWeight: 700,
                      color: M.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      marginBottom: 6,
                    }}
                  >
                    {g.group}
                  </div>
                  {/* Stacked related-doc nodes */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
                    {g.items.map((r) => (
                      <button
                        key={r.id}
                        onClick={r.href ? () => navigate(r.href as string) : undefined}
                        disabled={!r.href}
                        style={{
                          minWidth: 220,
                          padding: "9px 14px",
                          background: M.card,
                          border: `1px solid ${M.border}`,
                          borderRadius: 11,
                          color: M.raisin,
                          fontFamily: "inherit",
                          fontSize: 12.5,
                          fontWeight: 600,
                          cursor: r.href ? "pointer" : "default",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          textAlign: "left",
                          WebkitTapHighlightColor: "transparent",
                        }}
                      >
                        <span style={{ color: M.taupe, fontVariantNumeric: "tabular-nums" }}>
                          {r.code}
                        </span>
                        {r.subLine ? (
                          <span style={{ color: M.muted, fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {r.subLine}
                          </span>
                        ) : null}
                        {r.status ? (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 7px", borderRadius: 6, color: r.status.style.hex, marginLeft: "auto" }}>
                            {r.status.label}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </MobileCard>
          </div>
        ) : null}

        <div style={{ height: 12 }} />
      </div>

      {/* Inline action feedback (no ToastProvider on /m). */}
      {toast ? (
        <Toast
          toast={toast}
          onClose={() => setToast(null)}
          raised={showActionBar}
        />
      ) : null}

      {/* Bottom action bar — hidden for read-only detail (payslip / rack). */}
      {showActionBar ? (
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
      ) : null}

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

      {/* Proof of Delivery — same PUT the desktop DO detail uses. */}
      <PodSheet
        open={podOpen}
        onClose={() => setPodOpen(false)}
        onSubmit={async (pod: ProofOfDelivery) => {
          const res = await mutateJson(
            `/api/delivery-orders/${encodeURIComponent(id)}`,
            "PUT",
            { proofOfDelivery: pod, status: "DELIVERED" },
          );
          if (!res.ok) return { ok: false, error: res.error };
          refreshOne(`/api/delivery-orders/${encodeURIComponent(id)}`);
          refreshList("/api/delivery-orders");
          setToast({ kind: "ok", text: "Delivered — proof captured." });
          return { ok: true };
        }}
      />

      {/* Goods Receipt — same POST /api/grn the desktop receive form uses. */}
      <GrnReceiveSheet
        open={grnOpen}
        poId={id}
        onClose={() => setGrnOpen(false)}
        onSubmit={async (body) => {
          const res = await mutateJson("/api/grn", "POST", body);
          if (!res.ok) return { ok: false, error: res.error };
          refreshOne(`/api/purchase-orders/${encodeURIComponent(id)}`);
          refreshList("/api/grn");
          refreshList("/api/purchase-orders");
          setToast({ kind: "ok", text: "Goods received." });
          return { ok: true };
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

      {/* QR for this doc — opens from the Barcode card. Encodes the mobile
          detail URL so a phone-camera scan from another device opens this
          page. Order-type docs only (gated by the Open QR button render). */}
      <QrModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title={`${config.title} · ${code}`}
        choices={docQrChoices}
        downloadName={`${config.slug}-${code}`}
      />
    </>
  );
}

function Toast({
  toast,
  onClose,
  raised = true,
}: {
  toast: { kind: "ok" | "err"; text: string };
  onClose: () => void;
  /** Sit above the bottom action bar; when false sit above the tab bar only. */
  raised?: boolean;
}) {
  const ok = toast.kind === "ok";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: raised
          ? "calc(120px + env(safe-area-inset-bottom))"
          : "calc(72px + env(safe-area-inset-bottom))",
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
        marginTop: 18,
        overflowX: "auto",
        gap: 0,
        WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none",
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
              minWidth: 54,
              position: "relative",
            }}
          >
            {/* Connector from the previous dot (centered on the 18px dot row). */}
            {i > 0 ? (
              <div
                style={{
                  position: "absolute",
                  top: 8,
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
                width: 18,
                height: 18,
                borderRadius: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: done ? M.taupe : M.card,
                border: `2px solid ${done ? M.taupe : M.border}`,
              }}
            >
              {done ? <Check size={12} strokeWidth={3} color="#fff" /> : null}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 9.5,
                lineHeight: 1.2,
                textAlign: "center",
                color: isCurrent ? M.raisin : M.muted,
                fontWeight: isCurrent ? 700 : 600,
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

// Customization-chip tints — mirror the desktop SO line "Customization" chips
// (src/pages/sales/detail.tsx) via the shared mobile accent palette.
const CHIP_TONE: Record<
  NonNullable<NonNullable<LineItemVM["chips"]>[number]["tone"]>,
  { bg: string; fg: string }
> = {
  neutral: { bg: "#F0EAD8", fg: M.taupe },
  gold: M_ACCENT.gold,
  info: M_ACCENT.info,
  moss: M_ACCENT.moss,
  danger: M_ACCENT.danger,
  warning: M_ACCENT.warning,
  plum: M_ACCENT.plum,
};

function LineItemRow({
  item,
  first,
  onClick,
}: {
  item: LineItemVM;
  /** First row in the card — no top hairline. */
  first?: boolean;
  onClick: () => void;
}) {
  const hasDetail = (item.specs?.length ?? 0) > 0 || (item.chips?.length ?? 0) > 0;
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
        // Top-align when there are specs/chips so the icon sits beside the title.
        alignItems: hasDetail ? "flex-start" : "center",
        gap: 12,
        padding: "13px 16px",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {/* Gold icon tile (design source). Decorative — line items have no per-row
          icon field, so a generic Package glyph is used for all. */}
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: "#F0EAD8",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
          marginTop: hasDetail ? 1 : 0,
        }}
      >
        <Package size={18} strokeWidth={1.75} color={M.taupe} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Title + (right) meta on the same top line. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
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
              {item.title}
            </div>
            {item.subLine ? (
              <div
                style={{
                  color: M.muted,
                  fontSize: 11.5,
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
                gap: 3,
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
          ) : null}
        </div>

        {/* Spec rows — Category / Size / Fabric / Unit Price (label · value). */}
        {item.specs?.length ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "2px 14px",
              marginTop: 7,
            }}
          >
            {item.specs.map((s, i) => (
              <span key={i} style={{ fontSize: 11.5, color: M.muted }}>
                {s.label}{" "}
                <span
                  style={{
                    color: M.ink,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {s.value}
                </span>
              </span>
            ))}
          </div>
        ) : null}

        {/* Customization chips — Leg 6" / Divan 5" / Gap 2" / special / customs. */}
        {item.chips?.length ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 5,
              marginTop: 7,
            }}
          >
            {item.chips.map((c, i) => {
              const tone = CHIP_TONE[c.tone ?? "neutral"];
              return (
                <span
                  key={i}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: tone.fg,
                    background: tone.bg,
                    padding: "2px 7px",
                    borderRadius: 6,
                  }}
                >
                  {c.text}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      <ChevronRight
        size={17}
        strokeWidth={1.75}
        color="#C4BDB2"
        style={{ flexShrink: 0, marginTop: hasDetail ? 2 : 0 }}
      />
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
        {/* Edit only when this doc type is actually editable on mobile. A
            greyed, no-op Edit button (editing lives on desktop) read as broken
            and left two oversized half-width buttons — owner 2026-07-04. */}
        {editable ? (
          <SecondaryBtn
            label="Edit"
            icon={<Pencil size={16} strokeWidth={1.75} />}
            onClick={onEdit}
          />
        ) : null}
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

/** Section heading above a card (design source: 13/700 ink, margin 4px 4px 9px). */
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

/** Dark hero "stat" card (design source: rack hero on warehouse detail). */
function DarkStatCard({
  stat,
}: {
  stat: { eyebrow: string; value: string; caption?: React.ReactNode };
}) {
  return (
    <div
      style={{
        background: M.raisin,
        borderRadius: 18,
        padding: "17px 18px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 2,
          color: "#857A66",
          textTransform: "uppercase",
        }}
      >
        {stat.eyebrow}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          color: "#F0ECE9",
          marginTop: 2,
          letterSpacing: "-0.3px",
        }}
      >
        {stat.value}
      </div>
      {stat.caption != null ? (
        <div style={{ fontSize: 12, color: "#9A8F6B", marginTop: 4 }}>
          {stat.caption}
        </div>
      ) : null}
    </div>
  );
}

/** One row in a sub-document list (design source: payslips / rack contents). */
function SubDocRowView({
  row,
  first,
  onClick,
}: {
  row: SubDocRow;
  first?: boolean;
  onClick?: () => void;
}) {
  const interactive = typeof onClick === "function";
  // Movement rows use a tinted in/out tile; everything else a parchment tile.
  const isIn = row.icon === "arrow-down";
  const isOut = row.icon === "arrow-up";
  const tileBg = isIn ? "#EEF3E4" : isOut ? "#F9E1DA" : "#F0EAD8";
  const tileFg = isIn ? "#4F7C3A" : isOut ? "#9A3A2D" : M.taupe;
  const Icon = isIn
    ? ArrowDownToLine
    : isOut
      ? ArrowUpFromLine
      : row.icon === "package"
        ? Package
        : FileText;
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
        gap: 12,
        padding: "13px 16px",
        borderTop: first ? "none" : `1px solid ${M.divider}`,
        cursor: interactive ? "pointer" : "default",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: tileBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
        }}
      >
        <Icon size={18} strokeWidth={1.75} color={tileFg} />
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
          {row.title}
        </div>
        {row.subLine ? (
          <div
            style={{
              color: M.muted,
              fontSize: 11.5,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.subLine}
          </div>
        ) : null}
      </div>
      {row.status ? (
        <StatusPill style={row.status.style} label={row.status.label} size="sm" />
      ) : null}
      {row.trailing ? (
        <span
          style={{
            fontSize: 11.5,
            color: M.muted,
            flex: "none",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {row.trailing}
        </span>
      ) : null}
      {interactive ? (
        <ChevronRight
          size={17}
          strokeWidth={1.75}
          color="#C4BDB2"
          style={{ flexShrink: 0 }}
        />
      ) : null}
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
