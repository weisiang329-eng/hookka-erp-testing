// ---------------------------------------------------------------------------
// AuditLogTab — Accounting → Audit Log.
//
// Lists every document currently VOID or DELETED (newest action first) with
// who/when, and lets you Unvoid — the only way back for DELETED docs, which
// are hidden from the normal document lists. Each sourceType maps to its
// /lifecycle endpoint to repost the unvoid.
//
// Extracted verbatim from accounting/index.tsx (2026-07-04 file split). No
// behaviour change — same fetch, same search, same table.
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { LifecycleBadge } from "@/components/accounting/lifecycle-actions";
import { formatCurrency } from "@/lib/utils";
import { asMutationResponse } from "../shared";

type AuditRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  state: string;
  actionAt: string | null;
  actorUserId: string | null;
  actorName?: string | null;
  reference?: string;
  party?: string;
  amountSen?: number;
  docDate?: string;
};

const AUDIT_DOC_MAP: Record<string, { label: string; base: string }> = {
  payment_voucher: { label: "Expense Payment", base: "/api/accounting/payment-vouchers" },
  official_receipt: { label: "Official Receipt", base: "/api/accounting/official-receipts" },
  manual: { label: "Journal Entry", base: "/api/accounting/journals" },
  fund_transfer: { label: "Fund Transfer", base: "/api/accounting/fund-transfers" },
  other_party_bill: { label: "Other Party Bill", base: "/api/accounting/other-party-bills" },
  other_party_payment: { label: "Other Party Payment", base: "/api/accounting/other-party-payments" },
  supplier_payment: { label: "Supplier Payment", base: "/api/supplier-payments" },
};

export function AuditLogTab() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    fetch("/api/accounting/audit-log")
      .then((r) => r.json() as Promise<{ success?: boolean; data?: AuditRow[] }>)
      .then((j) => { if (j?.success) setRows(j.data ?? []); })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const unvoid = async (row: AuditRow) => {
    const map = AUDIT_DOC_MAP[row.sourceType];
    if (!map) { toast.error(`Don't know how to restore ${row.sourceType}`); return; }
    if (!(await confirm({ title: "Restore document?", message: `Restore ${map.label} ${row.sourceId}? It will be reposted to the GL.`, danger: false }))) return;
    const res = await fetch(`${map.base}/${encodeURIComponent(row.sourceId)}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unvoid" }),
    });
    const j = asMutationResponse(await res.json());
    if (j?.success) { toast.success(`${row.sourceId} restored`); load(); }
    else toast.error(j?.error || "Restore failed");
  };

  // Client-side search over the (≤1000) loaded rows — matches reference, party,
  // who (actor), type and state (#10).
  const q = query.trim().toLowerCase();
  const filtered =
    rows === null
      ? null
      : !q
        ? rows
        : rows.filter((r) =>
            [
              AUDIT_DOC_MAP[r.sourceType]?.label ?? r.sourceType,
              r.reference ?? r.sourceId,
              r.party,
              r.actorName ?? r.actorUserId,
              r.state,
              r.docDate,
            ].some((v) => (v ?? "").toLowerCase().includes(q)),
          );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Audit Log</h2>
          <p className="text-xs text-[#6B7280]">Voided &amp; deleted documents — the GL keeps every reversal; restore any of them here.</p>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search reference / party / who…"
          className="w-72 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
        />
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows === null ? (
            <div className="py-12 text-center text-[#6B7280] text-sm">Loading…</div>
          ) : (filtered ?? []).length === 0 ? (
            <div className="py-12 text-center text-[#9CA3AF] text-sm">{q ? "No documents match your search." : "No voided or deleted documents."}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Reference</th>
                  <th className="px-3 py-2 text-left">Doc Date</th>
                  <th className="px-3 py-2 text-left">Party</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-left">By</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(filtered ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-[#F0ECE9]">
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.actionAt ? r.actionAt.slice(0, 19).replace("T", " ") : "—"}</td>
                    <td className="px-3 py-1.5 text-xs">{AUDIT_DOC_MAP[r.sourceType]?.label ?? r.sourceType}</td>
                    <td className="px-3 py-1.5 tabular-nums text-xs font-medium">{r.reference ?? r.sourceId}</td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280] whitespace-nowrap">{r.docDate || "—"}</td>
                    <td className="px-3 py-1.5 text-xs">{r.party || "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-xs">{r.amountSen ? formatCurrency(r.amountSen) : "—"}</td>
                    <td className="px-3 py-1.5"><LifecycleBadge state={r.state} /></td>
                    <td className="px-3 py-1.5 text-xs text-[#6B7280]">{r.actorName ?? r.actorUserId ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button onClick={() => unvoid(r)} className="text-[#4F7C3A] hover:text-[#3A5C29] text-xs underline decoration-dotted cursor-pointer">unvoid</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
