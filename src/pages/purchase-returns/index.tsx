// ---------------------------------------------------------------------------
// Purchase Returns — supplier-side returns list + create-from-PI (owner
// 2026-07-30). Slice 1: create a Purchase Return from a Purchase Invoice (pick
// lines, qty, editable return cost, reason) and list them. No stock / AP
// movement yet — that is slices 2 (inventory reversal) + 3 (supplier Debit
// Note), each owner-verified. See docs/plans/2026-07-30-purchase-return.md.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, X, Undo2, Trash2 } from "lucide-react";

type PurchaseReturn = {
  id: string;
  return_no: string;
  pi_no: string | null;
  supplier_name: string | null;
  status: string | null;
  resolution: string | null;
  reason: string | null;
  created_at: string | null;
};

type PIOption = { id: string; piNo: string; supplierName: string; status?: string; paidAmountSen?: number };

type SourceLine = {
  purchaseInvoiceItemId?: string;
  materialCode: string | null;
  materialName: string;
  supplierSku: string | null;
  grnItemId: string | null;
  quantity: number;
  unitCostSen: number;
};

// A picked return line = a source line + the operator's return qty / cost / on flag.
type PickLine = SourceLine & { on: boolean; retQty: string; retCostRM: string; problem: string };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    const j = (await r.json()) as { success?: boolean; data?: T };
    return j.success ? (j.data ?? null) : null;
  } catch {
    return null;
  }
}

export default function PurchaseReturnsPage() {
  const [rows, setRows] = useState<PurchaseReturn[]>([]);
  const [loaded, setLoaded] = useState(false);
  // ?pi=<id> (from the "Create Purchase Return" button on a PI) preselects that
  // PI and opens the New dialog straight away (slice 4).
  const initialPiId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("pi") ?? "";
  }, []);
  const [showNew, setShowNew] = useState(!!initialPiId);

  const reload = useCallback(async () => {
    const data = await getJson<PurchaseReturn[]>("/api/purchase-returns");
    setRows(data ?? []);
    setLoaded(true);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => { void reload(); }, []);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const del = async (id: string) => {
    if (!window.confirm("Delete this OPEN purchase return?")) return;
    await fetch(`/api/purchase-returns/${id}`, { method: "DELETE" });
    await reload();
  };

  const confirmStock = async (r: PurchaseReturn) => {
    if (!window.confirm(`Confirm ${r.return_no} and REMOVE the returned goods from stock?\n\nThis reverses inventory (FIFO). The supplier Debit Note is the next step.`)) return;
    const res = await fetch(`/api/purchase-returns/${r.id}/confirm`, { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || !j.success) { window.alert(j.error || `Confirm failed (HTTP ${res.status})`); return; }
    await reload();
  };

  const issueDn = async (r: PurchaseReturn) => {
    if (!window.confirm(`Issue the supplier Debit Note for ${r.return_no}?\n\nThis reduces our Accounts Payable to the supplier AND posts a balanced GL journal. Verify the books after.`)) return;
    const res = await fetch(`/api/purchase-returns/${r.id}/issue-dn`, { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { noteNumber?: string } };
    if (!res.ok || !j.success) { window.alert(j.error || `Issue failed (HTTP ${res.status})`); return; }
    window.alert(`Debit Note ${j.data?.noteNumber ?? ""} issued.`);
    await reload();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#1F1D1B] tracking-tight flex items-center gap-2">
            <Undo2 className="w-6 h-6 text-[#6B5C32]" /> Purchase Returns
          </h1>
          <p className="text-sm text-[#6B7280] mt-0.5">Return goods to a supplier from a Purchase Invoice. (Stock + Debit Note are added in the next slices.)</p>
        </div>
        <button onClick={() => setShowNew(true)} className="h-10 px-4 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium hover:bg-[#3a3633] flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Purchase Return
        </button>
      </div>

      <div className="rounded-xl border border-[#E2DDD8] bg-white overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
            <tr>
              {["Return No", "PI", "Supplier", "Resolution", "Status", "Reason", ""].map((h) => (
                <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0ECE9]">
            {loaded && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-[#9CA3AF]">No purchase returns yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-[#FAF9F7]">
                <td className="px-4 py-2.5 font-mono font-medium text-[#1F1D1B]">{r.return_no}</td>
                <td className="px-4 py-2.5 text-[#6B7280]">{r.pi_no || "—"}</td>
                <td className="px-4 py-2.5 text-[#1F1D1B]">{r.supplier_name || "—"}</td>
                <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 rounded-full bg-[#F0ECE9] text-[#6B5C32]">{r.resolution === "CREDIT_NEXT_PI" ? "Credit next PI" : "Refund"}</span></td>
                <td className="px-4 py-2.5">
                  {(() => {
                    const st = r.status ?? "OPEN";
                    const label = st === "DN_ISSUED" ? "Debit Note issued" : st === "STOCK_OUT" ? "Stock removed" : st;
                    const cls = st === "DN_ISSUED" ? "bg-[#F1E6F0] text-[#6B4A6D]" : st === "STOCK_OUT" ? "bg-[#E7F4EC] text-[#15803D]" : "bg-[#EAF1FE] text-[#2563EB]";
                    return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
                  })()}
                </td>
                <td className="px-4 py-2.5 text-[#6B7280] max-w-[220px] truncate">{r.reason || "—"}</td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {(r.status ?? "OPEN") === "OPEN" && (
                    <>
                      <button onClick={() => void confirmStock(r)} className="text-xs font-medium px-2.5 py-1 rounded-md bg-[#6B5C32] text-white hover:bg-[#5A4D2A] mr-2">Confirm (remove stock)</button>
                      <button onClick={() => void del(r.id)} className="text-[#9A3A2D] hover:bg-[#F9E1DA] rounded p-1 align-middle"><Trash2 className="w-4 h-4" /></button>
                    </>
                  )}
                  {(r.status ?? "OPEN") === "STOCK_OUT" && (
                    <button onClick={() => void issueDn(r)} className="text-xs font-medium px-2.5 py-1 rounded-md bg-[#6B4A6D] text-white hover:bg-[#573C58]">Issue Debit Note</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && <NewPurchaseReturnDialog initialPiId={initialPiId} onClose={() => setShowNew(false)} onDone={async () => { setShowNew(false); await reload(); }} />}
    </div>
  );
}

function NewPurchaseReturnDialog({ initialPiId, onClose, onDone }: { initialPiId?: string; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [pis, setPis] = useState<PIOption[]>([]);
  const [piId, setPiId] = useState("");
  const [lines, setLines] = useState<PickLine[]>([]);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [resolution, setResolution] = useState("REFUND");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const raw = await getJson<Record<string, unknown>[]>("/api/purchase-invoices");
      const opts = (raw ?? []).map((p) => ({
        id: String(p.id ?? ""),
        piNo: String(p.piNo ?? p.pi_no ?? ""),
        supplierName: String(p.supplierName ?? p.supplier_name ?? ""),
        status: String(p.status ?? ""),
        paidAmountSen: Number(p.paidAmountSen ?? p.paid_amount_sen ?? 0),
      }));
      setPis(opts);
    })();
  }, []);

  const selectedPi = useMemo(() => pis.find((p) => p.id === piId) ?? null, [pis, piId]);

  const loadLines = async (id: string) => {
    setPiId(id);
    setLines([]);
    if (!id) return;
    const src = await getJson<{ items: SourceLine[]; paidAmountSen?: number }>(`/api/purchase-returns/source/pi/${id}`);
    const items = src?.items ?? [];
    setLines(items.map((it) => ({
      ...it,
      on: false,
      retQty: String(it.quantity ?? 0),
      retCostRM: ((it.unitCostSen ?? 0) / 100).toFixed(2),
      problem: "",
    })));
  };

  // Deep-linked from a PI ("Create Purchase Return"): preselect it + load lines.
  // Fires once on a user-driven prop (initialPiId), not a render loop, so the
  // cascading-render concern set-state-in-effect warns about doesn't apply.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (initialPiId) void loadLines(initialPiId);
  }, [initialPiId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const patch = (idx: number, p: Partial<PickLine>) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...p } : l)));

  const submit = async () => {
    const picked = lines.filter((l) => l.on && (parseFloat(l.retQty) || 0) > 0);
    if (!piId) { setErr("Pick a Purchase Invoice."); return; }
    if (picked.length === 0) { setErr("Tick at least one line with a quantity."); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/purchase-returns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchaseInvoiceId: piId,
          reason,
          notes,
          resolution,
          items: picked.map((l) => ({
            purchaseInvoiceItemId: l.purchaseInvoiceItemId,
            materialCode: l.materialCode,
            materialName: l.materialName,
            supplierSku: l.supplierSku,
            grnItemId: l.grnItemId,
            quantity: parseFloat(l.retQty) || 0,
            unitCostSen: Math.round((parseFloat(l.retCostRM) || 0) * 100),
            problem: l.problem,
          })),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { returnNo?: string } };
      if (!res.ok || !j.success) { setErr(j.error || `Failed (HTTP ${res.status})`); return; }
      window.alert(`Purchase Return ${j.data?.returnNo ?? ""} created.`);
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">New Purchase Return</h2>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="w-5 h-5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">Purchase Invoice
            <select value={piId} onChange={(e) => void loadLines(e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
              <option value="">— pick a PI —</option>
              {pis.map((p) => <option key={p.id} value={p.id}>{p.piNo} · {p.supplierName}{p.status ? ` · ${p.status}` : ""}</option>)}
            </select>
          </label>
          {selectedPi && (selectedPi.paidAmountSen ?? 0) > 0 ? (
            <div className="col-span-2 text-xs text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D597] rounded-lg px-3 py-2">
              This PI shows a payment on file — a return here is a supplier <b>refund</b> claim (Debit Note posts in slice 3).
            </div>
          ) : null}
        </div>

        {lines.length > 0 && (
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden mb-4">
            <table className="min-w-full text-sm">
              <thead className="bg-[#FAF9F7] border-b border-[#E2DDD8]">
                <tr>
                  {["", "Material", "Invoiced", "Return qty", "Unit cost (RM)", "Reason"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-[11px] font-semibold text-[#6B7280] uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0ECE9]">
                {lines.map((l, i) => (
                  <tr key={i} className={l.on ? "bg-[#F4F0E8]" : ""}>
                    <td className="px-2 py-1.5"><input type="checkbox" checked={l.on} onChange={(e) => patch(i, { on: e.target.checked })} className="w-4 h-4 accent-[#6B5C32]" /></td>
                    <td className="px-2 py-1.5"><span className="font-mono text-[#6B5C32]">{l.materialCode || "—"}</span> <span className="text-[#6B7280]">{l.materialName}</span></td>
                    <td className="px-2 py-1.5 text-[#9CA3AF] tabular-nums">{l.quantity}</td>
                    <td className="px-2 py-1.5"><input value={l.retQty} onChange={(e) => patch(i, { retQty: e.target.value })} disabled={!l.on} className="w-20 border border-[#E2DDD8] rounded px-1.5 py-1 text-sm disabled:bg-gray-50" /></td>
                    <td className="px-2 py-1.5"><input value={l.retCostRM} onChange={(e) => patch(i, { retCostRM: e.target.value })} disabled={!l.on} className="w-24 border border-[#E2DDD8] rounded px-1.5 py-1 text-sm disabled:bg-gray-50" /></td>
                    <td className="px-2 py-1.5"><input value={l.problem} onChange={(e) => patch(i, { problem: e.target.value })} disabled={!l.on} placeholder="e.g. damaged" className="w-full border border-[#E2DDD8] rounded px-1.5 py-1 text-sm disabled:bg-gray-50" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-[#6B7280] flex flex-col gap-1">Resolution
            <select value={resolution} onChange={(e) => setResolution(e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
              <option value="REFUND">Supplier refund</option>
              <option value="CREDIT_NEXT_PI">Credit against next PI</option>
            </select>
          </label>
          <label className="text-xs text-[#6B7280] flex flex-col gap-1">Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong item / damaged / over-supply" className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
          </label>
          <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] resize-none" />
          </label>
        </div>

        {err ? <div className="mt-3 text-xs text-[#9A3A2D] bg-[#F9E7E3] border border-[#E8B2A1] rounded-lg px-3 py-2">{err}</div> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E2DDD8] text-sm text-[#6B7280] hover:bg-[#F0ECE9]">Cancel</button>
          <button disabled={busy} onClick={() => void submit()} className="px-4 py-2 rounded-lg bg-[#6B5C32] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#5A4D2A]">{busy ? "Creating…" : "Create return"}</button>
        </div>
      </div>
    </div>
  );
}
