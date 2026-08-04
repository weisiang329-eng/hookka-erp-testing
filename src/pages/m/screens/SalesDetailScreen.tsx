// ===========================================================================
// SalesDetailScreen — L2 Sales Order detail.
//
// Owner 2026-07-02 (v20 React reference `MobileSoDetail.tsx`): "包括点进去看到
// 什么、点击 button 看到什么全部都要对齐". The SO detail IS the create form shown
// LOCKED (fld-ro), with a Total / Paid / Balance KPI strip on top, then Order
// Info, Line Items, Payments, Linked Documents, History; a status-dependent
// action bar. This rebuild matches that 1:1 with REAL data (design "A"):
//   • GET /api/sales-orders/:id → doc + linkedDOs/linkedInvoices/linkedPOs/
//     linkedPayments (same payload the generic detail used).
//   • Paid = sum of the SO's linked payments (real — NOT fabricated); Balance =
//     Total − Paid. (The list has no paid figure; the detail does.)
//   • Buttons wired to real endpoints: Confirm → POST …/confirm; Issue DO →
//     New-DO form; Edit → the SO edit form; Cancel → PUT status CANCELLED.
//   • History from /api/audit-events (same source the generic used).
//
// ADDITIVE: reached via a sales special-case in MobileLayout; the generic
// DocumentDetailScreen is untouched for every other module.
// ===========================================================================
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCachedJson } from "@/lib/cached-fetch";
import { StatusPill } from "../components";
import { FormSheet } from "../components";
import { M } from "../theme";
import { editSalesOrderSpec, newDeliveryOrderSpec } from "../config/forms";
import { type FormSpec } from "../config/form-types";
import { mutateJson, refreshOne, refreshList } from "../config/mutate";
import {
  resolveStatus,
  STATUS_MAPS,
  str,
  num,
  dateOnly,
  money,
} from "../config/helpers";

type RawRow = Record<string, unknown>;
type Envelope = { success?: boolean; data?: RawRow } & Record<string, unknown>;
type AuditResp = { data?: RawRow[] };

function arr(v: unknown): RawRow[] {
  return Array.isArray(v) ? (v as RawRow[]) : [];
}

export function SalesDetailScreen() {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const url = `/api/sales-orders/${encodeURIComponent(id)}`;
  const { data, loading, error } = useCachedJson<Envelope>(url);
  const { data: auditRaw } = useCachedJson<AuditResp>(
    id ? `/api/audit-events?resource=sales-orders&resourceId=${encodeURIComponent(id)}` : null,
  );

  const [editSpec, setEditSpec] = useState<FormSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const doc = data?.data ?? null;

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  };
  const reload = () => {
    refreshOne(url);
    refreshList("/api/sales-orders");
  };

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true);
    const r = await mutateJson(`${url}/confirm`, "POST");
    setBusy(false);
    if (r.ok) {
      reload();
      flash("Order confirmed");
    } else flash(r.error || "Confirm failed");
  };
  const onCancel = async () => {
    if (busy) return;
    if (!window.confirm(`Cancel ${str(doc ?? {}, "companySO") || "this order"}? You can undo this from the order page.`)) return;
    setBusy(true);
    const r = await mutateJson(url, "PUT", { status: "CANCELLED" });
    setBusy(false);
    if (r.ok) {
      reload();
      flash("Order cancelled");
    } else flash(r.error || "Cancel failed");
  };

  // Undo a cancel — the order, its production orders and the job cards this
  // cancel took down all return to their own prior statuses (owner 2026-08-04:
  // "i silap cancel"). Falls back to IN_PRODUCTION for rows cancelled before
  // pre_cancel_status existed.
  const onUndoCancel = async () => {
    if (busy) return;
    const target = str(doc ?? {}, "preCancelStatus") || "IN_PRODUCTION";
    if (!window.confirm(`Restore this order to ${target}? Cancelled production orders and job cards will be restored too.`)) return;
    setBusy(true);
    const r = await mutateJson(url, "PUT", { status: target });
    setBusy(false);
    if (r.ok) {
      reload();
      flash("Cancel undone");
    } else flash(r.error || "Undo failed");
  };

  if (loading && !doc) return <Center text="Loading…" />;
  if (error && !doc) return <Center text="Couldn’t load this order." />;
  if (!doc) return <Center text="Order not found." />;

  const status = str(doc, "status");
  const pill = resolveStatus(status, STATUS_MAPS.so);
  const items = arr(doc.items);
  const payments = arr((data as Envelope).linkedPayments);
  const dos = arr((data as Envelope).linkedDOs);
  const invoices = arr((data as Envelope).linkedInvoices);
  const pos = arr((data as Envelope).linkedPOs);
  const audit = arr(auditRaw?.data);

  const total = num(doc, "totalSen");
  const paid = payments.reduce((s, p) => s + num(p, "amount", "amountSen"), 0);
  const balance = total - paid;

  const info: [string, string][] = [
    ["Company SO", str(doc, "companySO", "companySOId") || "—"],
    ["Customer PO", str(doc, "customerPO", "customerPOId") || "—"],
    ["Customer PO Date", dateOnly(doc, "customerPODate") || "—"],
    ["Customer SO", str(doc, "customerSO", "customerSOId") || "—"],
    // Reference + Customer Delivery Date are real SO fields (sales-orders.ts
    // rowToSO) the design's SO grid shows. Payment Terms was dropped — the SO
    // GET never returns it, so that row always rendered "—".
    ["Reference", str(doc, "reference") || "—"],
    ["Customer", str(doc, "customerName") || "—"],
    ["Delivery Hub", str(doc, "hubName") || "—"],
    ["Order Date", dateOnly(doc, "companySODate") || "—"],
    ["Customer DD", dateOnly(doc, "customerDeliveryDate") || "—"],
    ["Expected DD", dateOnly(doc, "hookkaExpectedDD") || "—"],
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
            ‹ Sales Orders
          </button>
          <StatusPill style={pill.style} label={pill.label} size="sm" />
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: ".13em",
            textTransform: "uppercase",
            color: M.taupe,
            marginTop: 7,
          }}
        >
          {str(doc, "companySO", "companySOId")}
          {str(doc, "customerSO", "customerSOId") ? ` · Cust SO ${str(doc, "customerSO", "customerSOId")}` : ""}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: M.ink, letterSpacing: "-0.3px", marginTop: 1 }}>
          {str(doc, "customerName") || "—"}
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {/* KPI strip — Total / Paid / Balance (Paid = Σ linked payments). */}
        <div style={{ display: "flex", gap: 9, marginBottom: 12 }}>
          {([
            ["Total", total, M.ink],
            ["Paid", paid, "#4F7C3A"],
            ["Balance", balance, balance > 0 ? "#9A3A2D" : "#4F7C3A"],
          ] as [string, number, string][]).map(([l, v, col]) => (
            <div
              key={l}
              style={{
                flex: 1,
                minWidth: 0,
                background: M.card,
                border: `1px solid ${M.border}`,
                borderRadius: 14,
                padding: "11px 12px",
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".5px", textTransform: "uppercase", color: M.faint }}>
                {l}
              </span>
              <div style={{ fontSize: 14, fontWeight: 800, color: col, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {money(v)}
              </div>
            </div>
          ))}
        </div>

        {/* Order Info — locked fields (v20 fld-ro). */}
        <Card title="Order Info">
          <div style={{ padding: "6px 15px 12px" }}>
            {info.map(([l, v]) => (
              <div key={l} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: M.muted, marginBottom: 5 }}>{l}</div>
                <div
                  style={{
                    fontSize: 13,
                    background: M.paper,
                    border: `1px solid ${M.border}`,
                    borderRadius: 10,
                    padding: "11px 13px",
                    color: M.muted,
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Line items */}
        <Card title="Line Items" count={`${items.length} line${items.length === 1 ? "" : "s"}`}>
          {items.length === 0 ? (
            <Empty text="No line items" />
          ) : (
            items.map((it, i) => {
              const qty = num(it, "quantity", "qty");
              const unit = num(it, "unitPriceSen", "priceSen");
              const line = num(it, "lineTotalSen", "amountSen") || unit * qty;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "11px 15px",
                    borderTop: i ? `1px solid ${M.divider}` : "none",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: M.ink }}>
                      {str(it, "productName", "description", "productCode") || "—"}
                    </div>
                    {/* Spec line + variant chips — real SO item fields
                        (itemCategory/sizeLabel/fabricCode + leg/divan/gap/special),
                        matching the design's "Size 24 · BO315-24" + chips. */}
                    {(() => {
                      const sku = str(it, "productCode", "itemCode", "sku");
                      const spec = [
                        str(it, "itemCategory"),
                        str(it, "sizeLabel") ? `Size ${str(it, "sizeLabel")}` : "",
                        str(it, "fabricCode"),
                      ].filter(Boolean).join(" · ");
                      const chips = [
                        num(it, "legPriceSen") > 0 ? "Leg" : "",
                        num(it, "divanPriceSen") > 0 ? "Divan" : "",
                        num(it, "gapInches") > 0 ? `Gap ${num(it, "gapInches")}"` : "",
                        str(it, "specialOrder") ? "Special" : "",
                      ].filter(Boolean);
                      return (
                        <>
                          {sku || spec ? (
                            <div style={{ fontSize: 10.5, color: M.faint, marginTop: 3 }}>
                              {[sku ? `SKU ${sku}` : "", spec].filter(Boolean).join(" · ")}
                            </div>
                          ) : null}
                          {chips.length > 0 ? (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
                              {chips.map((c) => (
                                <span
                                  key={c}
                                  style={{ fontSize: 9.5, fontWeight: 700, color: M.taupe, background: M.paper, border: `1px solid ${M.border}`, borderRadius: 6, padding: "2px 6px" }}
                                >
                                  {c}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                  <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: M.taupe }}>{money(line)}</div>
                    <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>×{qty}</div>
                  </div>
                </div>
              );
            })
          )}
        </Card>

        {/* Payments */}
        <Card title="Payments" count={String(payments.length)}>
          {payments.length === 0 ? (
            <Empty text="No payments recorded" />
          ) : (
            payments.map((p, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "11px 15px",
                  borderTop: i ? `1px solid ${M.divider}` : "none",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: M.ink }}>
                    {str(p, "paymentMethod", "method", "receiptNumber") || "Payment"}
                  </div>
                  <div style={{ fontSize: 10.5, color: M.muted, marginTop: 2 }}>
                    {[dateOnly(p, "paymentDate", "createdAt"), str(p, "accountName"), str(p, "receivedBy")]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: M.taupe, whiteSpace: "nowrap" }}>
                  {money(num(p, "amount", "amountSen"))}
                </div>
              </div>
            ))
          )}
        </Card>

        {/* Linked documents */}
        {dos.length || invoices.length || pos.length ? (
          <Card title="Linked Documents">
            {dos.map((d, i) => (
              <LinkedRow
                key={`do${i}`}
                label="Delivery Order"
                code={str(d, "doNo")}
                onClick={() => navigate(`/m/delivery/${encodeURIComponent(str(d, "id"))}`)}
              />
            ))}
            {pos.map((p, i) => (
              <LinkedRow
                key={`po${i}`}
                label="Production Order"
                code={str(p, "poNo")}
                onClick={() => navigate(`/m/production/${encodeURIComponent(str(p, "id"))}`)}
              />
            ))}
            {invoices.map((v, i) => (
              <LinkedRow
                key={`inv${i}`}
                label="Invoice"
                code={str(v, "invoiceNo")}
                onClick={() => navigate(`/m/invoices/${encodeURIComponent(str(v, "id"))}`)}
              />
            ))}
          </Card>
        ) : null}

        {/* History */}
        {audit.length > 0 ? (
          <Card title="History">
            <div style={{ padding: "4px 15px 10px" }}>
              {audit.slice(0, 30).map((h, i) => (
                <div
                  key={i}
                  style={{ display: "flex", gap: 12, padding: "11px 0", borderTop: i ? `1px solid ${M.divider}` : "none", alignItems: "baseline" }}
                >
                  <span style={{ fontSize: 11, fontWeight: 600, color: M.muted, width: 78, flex: "none" }}>
                    {dateOnly(h, "createdAt", "ts", "timestamp") || ""}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: M.ink, flex: 1 }}>
                    {str(h, "action", "eventLabel", "summary", "message") || "—"}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: M.faint, flex: "none" }}>
                    {str(h, "actor", "userName", "userEmail")}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      {/* Status-dependent action bar */}
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
        {status === "DRAFT" ? (
          <>
            <Btn ghost flex={1} onClick={() => setEditSpec(editSalesOrderSpec(doc, id))}>Edit Draft</Btn>
            <Btn flex={1.3} busy={busy} onClick={onConfirm}>Confirm Order</Btn>
          </>
        ) : status === "CANCELLED" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
            <div style={{ textAlign: "center", fontSize: 11.5, color: M.muted, padding: "4px 0" }}>
              This order was cancelled.
            </div>
            <Btn busy={busy} onClick={onUndoCancel}>Undo Cancel</Btn>
          </div>
        ) : status === "CONFIRMED" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
            <Btn onClick={() => setEditSpec(newDeliveryOrderSpec())}>Issue Delivery Order</Btn>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn ghost flex={1} onClick={() => setEditSpec(editSalesOrderSpec(doc, id))}>Edit</Btn>
              <Btn danger flex={1} busy={busy} onClick={onCancel}>Cancel Order</Btn>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <Btn ghost flex={1} onClick={() => navigate(-1)}>Back</Btn>
            <Btn danger flex={1} busy={busy} onClick={onCancel}>Cancel Order</Btn>
          </div>
        )}
      </div>

      <FormSheet
        open={editSpec != null}
        onClose={() => setEditSpec(null)}
        spec={editSpec}
        onSaved={(to) => {
          setEditSpec(null);
          reload();
          if (to) navigate(to);
        }}
      />

      {toast ? (
        <div
          style={{
            position: "fixed",
            left: 18,
            right: 18,
            bottom: "calc(84px + env(safe-area-inset-bottom))",
            zIndex: 90,
            background: M.raisin,
            color: "#fff",
            borderRadius: 13,
            padding: "12px 16px",
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function Card({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 15px",
          borderBottom: `1px solid ${M.divider}`,
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: M.muted }}>
          {title}
        </span>
        {count ? <span style={{ fontSize: 10.5, color: M.faint }}>{count}</span> : null}
      </div>
      {children}
    </div>
  );
}

function LinkedRow({ label, code, onClick }: { label: string; code: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        padding: "12px 15px",
        borderTop: `1px solid ${M.divider}`,
        background: "none",
        border: "none",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: 12.5, color: M.muted }}>{label}</span>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: M.taupe, fontVariantNumeric: "tabular-nums" }}>
        {code || "—"} ›
      </span>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: "11px 15px", fontSize: 11.5, color: M.muted }}>{text}</div>;
}

function Btn({
  children,
  onClick,
  flex,
  ghost,
  danger,
  busy,
}: {
  children: ReactNode;
  onClick: () => void;
  flex?: number;
  ghost?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        flex: flex ?? undefined,
        width: flex ? undefined : "100%",
        height: 48,
        border: ghost || danger ? `1px solid ${danger ? "#E8B2A1" : M.border}` : "none",
        borderRadius: 12,
        background: ghost || danger ? M.card : M.taupe,
        color: danger ? "#9A3A2D" : ghost ? M.body : "#fff",
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: 700,
        cursor: busy ? "wait" : "pointer",
        opacity: busy ? 0.7 : 1,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}

function Center({ text }: { text: string }) {
  return (
    <div style={{ padding: "60px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>
  );
}
