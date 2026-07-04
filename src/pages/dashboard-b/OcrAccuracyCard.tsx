// ---------------------------------------------------------------------------
// OcrAccuracyCard — a Dashboard block (owner 2026-07-04). Shows the OCR
// success rate (upload → did the operator change anything? changed = fail) so
// the owner knows which customer / supplier is safe to automate (Gmail →
// auto-draft → auto-confirm needs ~100%). Data: GET /api/ocr-accuracy.
// Self-contained (own fetch) so it drops into the dashboard with one line.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useCachedJson } from "@/lib/cached-fetch";
import { ChevronRight, ChevronDown, ScanLine } from "lucide-react";

type Bucket = {
  key: string;
  total: number;
  success: number;
  rate: number | null;
  topFails: string[];
  children?: Bucket[];
};
type Resp = {
  success?: boolean;
  data?: {
    overall: { total: number; success: number; rate: number | null };
    salesOrders: Bucket & { customers: Bucket[] };
    supplier: Bucket & { suppliers: Bucket[] };
  };
};

function rateColor(rate: number | null): string {
  if (rate === null) return "#9CA3AF";
  if (rate >= 97) return "#3B6D11";
  if (rate >= 85) return "#B5701A";
  return "#A32D2D";
}
function pct(rate: number | null): string {
  return rate === null ? "—" : `${rate}%`;
}

function Tile({ label, rate, sub }: { label: string; rate: number | null; sub: string }) {
  return (
    <div className="rounded-lg bg-[#F5F1EA] px-4 py-3">
      <div className="text-xs text-[#8A8577] mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" style={{ color: rateColor(rate) }}>{pct(rate)}</div>
      <div className="text-[11px] text-[#9A9384]">{sub}</div>
    </div>
  );
}

function CustomerRow({ b }: { b: Bucket }) {
  const [open, setOpen] = useState(false);
  const hasKids = (b.children?.length ?? 0) > 0;
  return (
    <>
      <tr
        className={`border-t border-[#F0ECE3] ${hasKids ? "cursor-pointer" : ""}`}
        onClick={hasKids ? () => setOpen((v) => !v) : undefined}
      >
        <td className="px-3 py-2 font-medium text-[#1F1D1B]">
          {hasKids ? (
            open ? <ChevronDown className="inline h-3.5 w-3.5 text-[#8A8577] mr-1" /> : <ChevronRight className="inline h-3.5 w-3.5 text-[#8A8577] mr-1" />
          ) : null}
          {b.key}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{b.total}</td>
        <td className="px-2 py-2 text-right tabular-nums font-semibold" style={{ color: rateColor(b.rate) }}>{pct(b.rate)}</td>
        <td className="px-3 py-2 text-[#8A8577] text-xs">{b.topFails.length ? b.topFails.join(" · ") : "—"}</td>
      </tr>
      {open && hasKids
        ? b.children!.map((cc) => (
            <tr key={cc.key} className="border-t border-[#F6F2EA]">
              <td className="py-1.5 pl-9 pr-3 text-[#5F5E5A]">{cc.key}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[#9A9384]">{cc.total}</td>
              <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: rateColor(cc.rate) }}>{pct(cc.rate)}</td>
              <td className="px-3 py-1.5 text-[#9A9384] text-xs">{cc.topFails.length ? cc.topFails.join(" · ") : "—"}</td>
            </tr>
          ))
        : null}
    </>
  );
}

export function OcrAccuracyCard() {
  const { data, loading } = useCachedJson<Resp>("/api/ocr-accuracy");
  const d = data?.data;

  return (
    <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
          <div className="flex items-center gap-2">
            <ScanLine className="h-4.5 w-4.5 text-[#6B5C32]" />
            <span className="text-base font-semibold text-[#1F1D1B]">OCR Accuracy</span>
          </div>
          <span className="text-xs text-[#8A8577]">Changed after upload = Fail · automate only near ~100%</span>
        </div>

        {loading && !d ? (
          <div className="py-10 text-center text-sm text-[#9CA3AF]">Loading…</div>
        ) : !d || d.overall.total === 0 ? (
          <div className="py-10 text-center text-sm text-[#9CA3AF]">
            No scans yet. Once you scan and import orders / supplier docs, the accuracy shows here automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-5">
              <Tile label="Overall" rate={d.overall.rate} sub={`${d.overall.success} / ${d.overall.total} clean`} />
              <Tile label="Sales Orders" rate={d.salesOrders.rate} sub={`${d.salesOrders.total} scans`} />
              <Tile label="Supplier (PO/PI/GRN)" rate={d.supplier.rate} sub={`${d.supplier.total} scans`} />
            </div>

            {d.salesOrders.customers.length > 0 ? (
              <div className="mb-5">
                <div className="text-sm font-semibold text-[#6B5C32] mb-2">Sales Orders · Customer × Category <span className="font-normal text-[11px] text-[#9A9384]">(click a customer to expand categories)</span></div>
                <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#FAF7F2] text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <th className="px-3 py-2 text-left">Customer / Category</th>
                        <th className="px-2 py-2 text-right">Scans</th>
                        <th className="px-2 py-2 text-right">Success</th>
                        <th className="px-3 py-2 text-left">Most-changed fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.salesOrders.customers.slice(0, 12).map((cust) => (
                        <CustomerRow key={cust.key} b={cust} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {d.supplier.suppliers.length > 0 ? (
              <div>
                <div className="text-sm font-semibold text-[#6B5C32] mb-2">Supplier · by Supplier (PO / PI / GRN)</div>
                <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#FAF7F2] text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <th className="px-3 py-2 text-left">Supplier</th>
                        <th className="px-2 py-2 text-right">Scans</th>
                        <th className="px-2 py-2 text-right">Success</th>
                        <th className="px-3 py-2 text-left">Most-changed fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.supplier.suppliers.slice(0, 12).map((s) => (
                        <tr key={s.key} className="border-t border-[#F0ECE3]">
                          <td className="px-3 py-2 font-medium text-[#1F1D1B]">{s.key}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{s.total}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-semibold" style={{ color: rateColor(s.rate) }}>{pct(s.rate)}</td>
                          <td className="px-3 py-2 text-[#8A8577] text-xs">{s.topFails.length ? s.topFails.join(" · ") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
