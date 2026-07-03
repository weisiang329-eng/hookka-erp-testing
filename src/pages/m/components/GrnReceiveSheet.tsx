// ===========================================================================
// GrnReceiveSheet — mobile Goods Receipt (Build Spec: PO → Receive → per-line
// qty → GRN created, PO → Partial/Received). Reuses the EXACT desktop payload
// (procurement/grn/create.tsx): POST /api/grn { poId, purchaseOrgCode,
// receivedBy, notes, ocrUsed:false, items:[{materialName, materialCode,
// receivedQty, acceptedQty, rejectedQty, unitPriceSen}] }. Backend bumps each
// PO line's receivedQty and flips the PO to PARTIAL_RECEIVED / RECEIVED, and
// posts the goods to stock (rm_batches / cost_ledger).
// ===========================================================================
import { useState } from "react";
import { Sheet } from "./Sheet";
import { M } from "../theme";
import { useCachedJson } from "@/lib/cached-fetch";
import { str, num } from "../config/helpers";

type POItem = Record<string, unknown>;
type POResp = { data?: { purchaseOrgCode?: string; items?: POItem[] } };

type Props = {
  open: boolean;
  poId: string;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
};

export function GrnReceiveSheet({ open, poId, onClose, onSubmit }: Props) {
  const { data } = useCachedJson<POResp>(open && poId ? `/api/purchase-orders/${encodeURIComponent(poId)}` : null);
  const po = data?.data;
  // The backend keys GRN lines to PO lines by poItemIndex = the line's
  // position in the PO endpoints' canonical order. Since 2026-07-04 the
  // SERVER guarantees that order (`ORDER BY line_no NULLS LAST, id` — paper
  // order for new POs, legacy id-order for backfilled rows) on BOTH the PO
  // GET and every grn.ts matcher, so the row index the operator sees IS the
  // poItemIndex the backend expects. Do NOT re-add the old client-side sort
  // by raw id (the 2cfa3ba7 stopgap) — ids are random, so it would scramble
  // new POs' paper order while the backend serves line_no order.
  const items = Array.isArray(po?.items) ? (po!.items as POItem[]) : [];

  const [recv, setRecv] = useState<Record<number, number>>({});
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Per-line "receive now" — default to the remaining (availableQty) unless the
  // operator overrides it. Computed inline so we never seed state from a fetch.
  const remainingOf = (it: POItem) => {
    const avail = num(it, "availableQty");
    return avail > 0 ? avail : Math.max(0, num(it, "quantity") - num(it, "receivedQty"));
  };
  const qtyFor = (i: number, it: POItem) => (recv[i] ?? remainingOf(it));

  const confirm = async () => {
    if (busy) return;
    // PO-linked GRN lines key to PO lines by INDEX (backend grn.ts: grn_items
    // .poItemIndex → purchase_order_items ORDER BY id). Send poItemIndex + qtys;
    // the backend looks up material/price from the PO line — matches the desktop
    // receive form (procurement/grn/create.tsx). poItemIndex is the ORIGINAL
    // index (kept before filtering out the zero lines).
    const lines = items
      .map((_it, i) => ({ poItemIndex: i, q: qtyFor(i, items[i]) }))
      .filter((x) => x.q > 0)
      .map(({ poItemIndex, q }) => ({
        poItemIndex,
        receivedQty: q,
        acceptedQty: q,
        rejectedQty: 0,
        rejectionReason: "",
      }));
    if (lines.length === 0) {
      setErr("Enter a received quantity for at least one line.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await onSubmit({
      poId,
      purchaseOrgCode: str(po ?? {}, "purchaseOrgCode") || "HOOKKA",
      receivedBy: receivedBy.trim(),
      notes: notes.trim(),
      ocrUsed: false,
      // Mobile "receive now" = goods in hand → post immediately (GRN → POSTED, PO
      // line receivedQty bumped, stock in). Without this a PO-linked GRN defaults
      // to NOT_ARRIVED/DRAFT and never posts.
      arrival_state: "ARRIVED",
      items: lines,
    });
    setBusy(false);
    if (res.ok) {
      setRecv({});
      setReceivedBy("");
      setNotes("");
      onClose();
    } else {
      setErr(res.error || "Couldn't create the goods receipt.");
    }
  };

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: M.ink, margin: "12px 0 6px" };
  const input: React.CSSProperties = {
    width: "100%",
    height: 42,
    border: `1px solid ${M.hairline}`,
    borderRadius: 11,
    padding: "0 13px",
    fontSize: 13.5,
    color: M.raisin,
    background: M.paper,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  return (
    <Sheet open={open} onClose={onClose} title="Receive Goods (GRN)">
      <div style={{ padding: "4px 16px calc(16px + env(safe-area-inset-bottom))", overflowY: "auto", maxHeight: "calc(88dvh - 60px)" }}>
        {items.length === 0 ? (
          <div style={{ color: M.muted, fontSize: 13, padding: "20px 0", textAlign: "center" }}>Loading purchase order…</div>
        ) : (
          <>
            <div style={{ ...label, marginTop: 6 }}>Lines to receive</div>
            {items.map((it, i) => {
              const remaining = remainingOf(it);
              return (
                <div key={i} style={{ border: `1px solid ${M.border}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: M.ink }}>
                    {str(it, "materialName") || str(it, "materialCode", "material_code") || "Material"}
                  </div>
                  <div style={{ fontSize: 11, color: M.muted, marginTop: 2 }}>
                    Ordered {num(it, "quantity")} · already received {num(it, "receivedQty")} · remaining {remaining}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                    <span style={{ fontSize: 11.5, color: M.muted, fontWeight: 600 }}>Receive now</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={remaining}
                      value={String(qtyFor(i, it))}
                      onChange={(e) => setRecv((p) => ({ ...p, [i]: Math.max(0, Number(e.target.value) || 0) }))}
                      style={{ ...input, width: 90, height: 38, textAlign: "right" }}
                    />
                  </div>
                </div>
              );
            })}

            <div style={label}>Received by</div>
            <input style={input} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Who received it" />

            <div style={label}>Notes</div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              rows={2}
              style={{ ...input, height: 56, padding: "10px 13px", resize: "none" }}
            />

            {err ? <div style={{ color: "#9A3A2D", fontSize: 12.5, marginTop: 10, fontWeight: 600 }}>{err}</div> : null}

            <button
              onClick={confirm}
              disabled={busy}
              style={{ width: "100%", height: 50, marginTop: 16, border: "none", borderRadius: 13, background: busy ? "#B7C4A6" : "#4F7C3A", color: "#fff", fontFamily: "inherit", fontSize: 15, fontWeight: 700, cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "Receiving…" : "Confirm Goods Receipt"}
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
