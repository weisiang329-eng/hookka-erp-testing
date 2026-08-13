// ---------------------------------------------------------------------------
// Trade Finance block (owner 2026-08-11) — lives on the Creditor Aging tab,
// as its own section, NEVER mixed into the trade-creditor rows: this money is
// owed to a LENDER (Houzs Century) for supplier bills it paid on our behalf.
//
// Buckets run on each draw's DUE date. The identity line the owner can check
// at a glance: Σ draw outstanding + unallocated = TF account ledger net.
// Amounts are ledger-derived server-side (loadTfDraws) — this block only
// displays, edits due dates, and links to the Supplier Payment screen to
// repay (payee = the lender; the grid there lists draws instead of PIs).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { moneyFieldToRinggit, firstMoneyFieldError } from "@/lib/money-field";
import { Landmark, Settings2 } from "lucide-react";

type TfDrawRow = {
  drawSourceId: string;
  drawDate: string;
  dueDate: string;
  amountSen: number;
  interestSen: number;
  repaidSen: number;
  outstandingSen: number;
  paidSupplier: string;
};
type TfSourceRow = {
  accountCode: string;
  lenderSupplierId: string;
  lenderName: string;
  tenorDays: number;
  accountName: string;
  accountNetSen: number;
  unallocatedSen: number;
  totals: { notDue: number; d1_30: number; d31_60: number; d61_90: number; over90: number; total: number };
  draws: TfDrawRow[];
};

const rm = (sen: number) =>
  (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BUCKETS: { key: keyof TfSourceRow["totals"]; label: string }[] = [
  { key: "notDue", label: "Not due" },
  { key: "d1_30", label: "1-30 d" },
  { key: "d31_60", label: "31-60 d" },
  { key: "d61_90", label: "61-90 d" },
  { key: "over90", label: "90+ d" },
  { key: "total", label: "Total" },
];

export function TradeFinanceBlock() {
  const { toast } = useToast();
  const [sources, setSources] = useState<TfSourceRow[] | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const load = useCallback(() => {
    fetch("/api/accounting/trade-finance", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { sources?: TfSourceRow[] } }>)
      .then((j) => setSources(j?.success ? (j.data?.sources ?? []) : []))
      .catch(() => setSources([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveDue = async (drawSourceId: string, dueDate: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return;
    const res = await fetch("/api/accounting/trade-finance/draw-due", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawSourceId, dueDate }),
    }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    if (j?.success) { toast.success("Due date saved"); load(); }
    else toast.error(j?.error || "Couldn't save the due date");
  };

  // Keys the draw's TOTAL interest (the bank's figure); the server delta-posts
  // DR INTEREST ON TRADE FINANCE / CR the TF account under this draw, so
  // outstanding + the identity include it. Same figure twice = no-op.
  const saveInterest = async (drawSourceId: string, rmStr: string) => {
    // BUG-2026-08-13-095 — the interest cell is a free-text input, so the
    // bank's "1,250.00" reached `parseFloat` whole and posted RM 1.00 of
    // interest against the draw. Silence was the danger: the old guard simply
    // `return`ed, so an unreadable figure looked like a saved one.
    const tfMoneyError = firstMoneyFieldError([{ label: "Interest (RM)", value: rmStr }]);
    if (tfMoneyError) { toast.error(tfMoneyError); return; }
    const rmv = moneyFieldToRinggit(rmStr) as number;
    if (rmv < 0) { toast.error("Interest cannot be negative"); return; }
    const res = await fetch("/api/accounting/trade-finance/draw-interest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drawSourceId, interestSen: Math.round(rmv * 100) }),
    }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { success?: boolean; error?: string; data?: { unchanged?: boolean } } | null;
    if (j?.success) { if (!j.data?.unchanged) { toast.success("Interest posted"); } load(); }
    else toast.error(j?.error || "Couldn't save the interest");
  };

  if (sources === null) return null; // loading — the aging tab renders fine without it
  return (
    <div className="space-y-4">
      {sources.map((s) => (
        <Card key={s.accountCode}>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-[#1F1D1B] flex items-center gap-2">
                <Landmark className="h-4 w-4 text-[#6B5C32]" />
                TRADE FINANCE — {s.lenderName}
              </h3>
              <span className="text-[11px] text-[#9CA3AF]">
                {s.accountCode} {s.accountName} · default tenor {s.tenorDays} days · buckets by DUE date
              </span>
              <div className="ml-auto flex items-center gap-2">
                <a href={`/invoices/supplier-payments?supplier=${encodeURIComponent(s.lenderSupplierId)}`}>
                  <Button size="sm">Repay</Button>
                </a>
                <Button variant="outline" size="sm" onClick={() => setShowSetup((v) => !v)}>
                  <Settings2 className="h-4 w-4 mr-1" /> Settings
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {BUCKETS.map((b) => (
                <div key={b.key} className={`rounded-md border border-[#E2DDD8] px-3 py-1.5 ${b.key === "total" ? "bg-[#F6F1E7]" : "bg-white"}`}>
                  <p className="text-[10px] text-[#6B7280]">{b.label}</p>
                  <p className={`text-sm font-semibold tabular-nums ${b.key === "over90" && s.totals.over90 > 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                    {rm(s.totals[b.key])}
                  </p>
                </div>
              ))}
            </div>
            {/* The identity the owner checks at a glance. Red = doesn't tie. */}
            <p className={`text-[11px] ${s.totals.total + s.unallocatedSen === s.accountNetSen ? "text-[#9CA3AF]" : "text-[#9A3A2D] font-semibold"}`}>
              Draws {rm(s.totals.total)}
              {s.unallocatedSen !== 0 && <> + unallocated {rm(s.unallocatedSen)}</>}
              {" = account balance "}{rm(s.accountNetSen)}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]/50 text-[#6B7280]">
                    <th className="py-2 px-3 text-left font-medium">Draw</th>
                    <th className="py-2 px-3 text-left font-medium">Paid supplier</th>
                    <th className="py-2 px-3 text-left font-medium">Draw date</th>
                    <th className="py-2 px-3 text-left font-medium">Due date</th>
                    <th className="py-2 px-3 text-right font-medium">Principal</th>
                    <th className="py-2 px-3 text-right font-medium">Interest</th>
                    <th className="py-2 px-3 text-right font-medium">Repaid</th>
                    <th className="py-2 px-3 text-right font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {s.draws.length === 0 && (
                    <tr><td colSpan={8} className="py-4 px-3 text-center text-[#9CA3AF]">No open draws.</td></tr>
                  )}
                  {s.draws.map((d) => (
                    <tr key={d.drawSourceId} className="border-b border-[#F0ECE9]">
                      <td className="py-1.5 px-3 tabular-nums">{d.drawSourceId}</td>
                      <td className="py-1.5 px-3">{d.paidSupplier || "-"}</td>
                      <td className="py-1.5 px-3 tabular-nums">{d.drawDate}</td>
                      <td className="py-1.5 px-3">
                        {/* Editable in place — the bank's real maturity date. */}
                        <input
                          type="date"
                          defaultValue={d.dueDate}
                          onBlur={(e) => { if (e.target.value && e.target.value !== d.dueDate) void saveDue(d.drawSourceId, e.target.value); }}
                          className="rounded border border-[#E2DDD8] px-1.5 py-0.5 text-[12px] bg-white"
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{rm(d.amountSen - d.interestSen)}</td>
                      <td className="py-1.5 px-3 text-right">
                        {/* The bank's charged interest — keyed here (OCR prefill
                            later); posts to 900-I001 and joins the balance. */}
                        <input
                          key={`${d.drawSourceId}:${d.interestSen}`}
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={d.interestSen ? (d.interestSen / 100).toFixed(2) : ""}
                          placeholder="0.00"
                          onBlur={(e) => {
                            const cur = d.interestSen ? (d.interestSen / 100).toFixed(2) : "";
                            if (e.target.value !== cur && e.target.value !== "") void saveInterest(d.drawSourceId, e.target.value);
                          }}
                          className="w-24 rounded border border-[#E2DDD8] px-1.5 py-0.5 text-[12px] text-right tabular-nums bg-white"
                        />
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{d.repaidSen ? rm(d.repaidSen) : "-"}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{rm(d.outstandingSen)}</td>
                    </tr>
                  ))}
                  {s.draws.length > 0 && (
                    <tr className="border-t-2 border-[#E2DDD8] bg-[#F6F1E7] font-semibold">
                      <td className="py-2 px-3" colSpan={4}>TOTAL</td>
                      <td className="py-2 px-3 text-right tabular-nums">{rm(s.draws.reduce((t, d) => t + d.amountSen - d.interestSen, 0))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{rm(s.draws.reduce((t, d) => t + d.interestSen, 0))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{rm(s.draws.reduce((t, d) => t + d.repaidSen, 0))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{rm(s.draws.reduce((t, d) => t + d.outstandingSen, 0))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}
      {(sources.length === 0 || showSetup) && (
        <TfSetupCard
          existing={sources[0] ?? null}
          onSaved={() => { setShowSetup(false); load(); }}
        />
      )}
    </div>
  );
}

// Setup = the ONE owner-pressed write that also reclasses the account in
// place (LIABILITY, renamed, out of the bank lists). The confirm spells that
// out — nothing here happens silently.
function TfSetupCard({ existing, onSaved }: { existing: TfSourceRow | null; onSaved: () => void }) {
  const { toast } = useToast();
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [accountCode, setAccountCode] = useState(existing?.accountCode ?? "310-0020");
  const [lenderSupplierId, setLenderSupplierId] = useState(existing?.lenderSupplierId ?? "");
  const [tenorDays, setTenorDays] = useState(String(existing?.tenorDays ?? 90));
  const [accountName, setAccountName] = useState(existing?.accountName ?? "");
  const [nameTouched, setNameTouched] = useState(!!existing);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch("/api/suppliers")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: { id: string; name: string }[] }>)
      .then((j) => {
        const list = Array.isArray(j?.data) ? j.data : [];
        setSuppliers(list.map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {});
  }, []);
  const lenderName = suppliers.find((s) => s.id === lenderSupplierId)?.name ?? "";
  // Derived, not synced: until the owner touches the name field it follows the
  // picked lender (`TRADE FINANCE - <LENDER>`), no effect needed.
  const effectiveAccountName = nameTouched || !lenderName ? accountName : `TRADE FINANCE - ${lenderName}`;

  const save = async () => {
    if (!accountCode.trim() || !lenderSupplierId || !effectiveAccountName.trim()) {
      toast.error("Account, lender and the new account name are all required");
      return;
    }
    const ok = window.confirm(
      `Set up trade finance?\n\nAccount ${accountCode} becomes a LIABILITY named "${effectiveAccountName}" and leaves the bank / cash-book lists. The ledger itself is not touched — history reads correctly at every date.\n\nDraws (money ${lenderName} paid suppliers for us) will be tracked with due dates; repay through Supplier Payment to ${lenderName}.`,
    );
    if (!ok) return;
    setSaving(true);
    const res = await fetch("/api/accounting/trade-finance/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountCode: accountCode.trim(), lenderSupplierId, tenorDays: Math.round(Number(tenorDays) || 90), accountName: effectiveAccountName.trim() }),
    }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    setSaving(false);
    if (j?.success) { toast.success("Trade finance configured"); onSaved(); }
    else toast.error(j?.error || "Setup failed");
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#1F1D1B] flex items-center gap-2">
          <Landmark className="h-4 w-4 text-[#6B5C32]" /> Trade finance — set up
        </h3>
        <p className="text-[11px] text-[#6B7280]">
          For supplier bills a related company pays on our behalf (their trade-finance line). Saving reclasses the
          account below to a LIABILITY and starts per-draw due-date tracking.
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-[#6B7280]">
            Account code
            <input value={accountCode} onChange={(e) => setAccountCode(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm bg-white" />
          </label>
          <label className="text-xs text-[#6B7280]">
            Lender (supplier)
            <select value={lenderSupplierId} onChange={(e) => setLenderSupplierId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm bg-white">
              <option value="">— pick —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[#6B7280]">
            Default tenor (days)
            <input type="number" min={1} max={365} value={tenorDays} onChange={(e) => setTenorDays(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm bg-white" />
          </label>
          <label className="text-xs text-[#6B7280]">
            New account name
            <input value={effectiveAccountName} onChange={(e) => { setNameTouched(true); setAccountName(e.target.value); }}
              className="mt-1 w-full rounded-md border border-[#E2DDD8] px-2 py-1.5 text-sm bg-white" />
          </label>
        </div>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save & reclassify"}
        </Button>
      </CardContent>
    </Card>
  );
}
