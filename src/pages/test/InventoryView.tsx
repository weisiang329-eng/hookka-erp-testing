import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useCachedJson } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Boxes, PackageCheck, Layers, Wallet } from "lucide-react";
import { TAUPE, MUTED, BORDER, fmtN } from "./dashboard-shared-lib";
import { Kpi, LiveBadge, MissingNote } from "./dashboard-shared";

// Real data from GET /api/dashboard/prototype — the `inventory` +
// `availability.inventory` slices (raw_materials + rm_batches, src/api/
// routes/dashboard-prototype.ts). Stock age bands and item values come off
// rm_batches; raw_materials alone carries neither cost nor a receipt date.
type Feed = {
  success?: boolean;
  availability?: { inventory?: { live: boolean; reason?: string; rows: number; missing?: string[] } };
  inventory?: {
    groups: { group: string; items: number; withStock: number; qty: number }[];
    totals: {
      items: number; active: number; withStock: number; withMinStock: number;
      stockValueSen: number; batchesWithStock: number;
    };
    ageing: { key: string; label: string; batches: number; qty: number; valueSen: number }[];
    items: { code: string | null; description: string | null; group: string | null; uom: string | null; balanceQty: number; valueSen: number; oldestDays: number | null }[];
    finishedGoods: { code: string; name: string; category: string | null; available: number; reserved: number }[];
  };
};

const AGE_COLOR = [TAUPE, "#8C5A42", "#9C6F1E", "#9A3A2D"];

export function InventoryView() {
  const { data, loading, error } = useCachedJson<Feed>("/api/dashboard/prototype");

  const inv = data?.inventory;
  const live = data?.availability?.inventory?.live ?? false;
  const missing = data?.availability?.inventory?.missing ?? [];

  const ageingChart = useMemo(
    () => (inv?.ageing ?? []).map((b) => ({ band: b.label, ValueSen: Math.round(b.valueSen / 100) })),
    [inv?.ageing],
  );

  const topItems = useMemo(() => (inv?.items ?? []).slice(0, 30), [inv?.items]);
  const topFG = useMemo(
    () => [...(inv?.finishedGoods ?? [])].slice(0, 12),
    [inv?.finishedGoods],
  );

  if (loading) {
    return <div className="py-16 text-center text-sm text-[#6B7280]">Loading…</div>;
  }
  if (error || !data?.success) {
    return (
      <Card className="border-[#F0D9AE] bg-[#FDF3E4]">
        <CardContent className="p-4 text-sm text-[#B5701A]">
          Couldn't load Inventory: {error ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-md:space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-[#1F1D1B]">Inventory</h2>
        <LiveBadge live={live} />
      </div>
      <MissingNote fields={missing} />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <Kpi
          label="Raw Material Items"
          value={fmtN(inv?.totals.items ?? 0)}
          sub={`${fmtN(inv?.totals.active ?? 0)} active`}
          icon={Boxes}
          iconBgClass="bg-[#F0ECE9]"
          iconColorClass="text-[#6B5C32]"
        />
        <Kpi
          label="With Stock"
          value={fmtN(inv?.totals.withStock ?? 0)}
          icon={PackageCheck}
          iconBgClass="bg-[#EEF3E4]"
          iconColorClass="text-[#4F7C3A]"
          valueColorClass="text-[#4F7C3A]"
        />
        <Kpi
          label="Batches on Hand"
          value={fmtN(inv?.totals.batchesWithStock ?? 0)}
          icon={Layers}
          iconBgClass="bg-[#E6F0F3]"
          iconColorClass="text-[#3E6570]"
          valueColorClass="text-[#3E6570]"
        />
        <Kpi
          label="Stock Value"
          value={formatCurrency(inv?.totals.stockValueSen ?? 0)}
          icon={Wallet}
          iconBgClass="bg-[#FAEFCB]"
          iconColorClass="text-[#9C6F1E]"
          valueColorClass="text-[#9C6F1E]"
          valueSizeClass="text-xl"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Stock value by age</CardTitle>
        </CardHeader>
        <CardContent>
          <div style={{ width: "100%", height: 200 }}>
            {ageingChart.every((b) => b.ValueSen === 0) ? (
              <div className="flex items-center justify-center h-full text-xs text-[#6B7280]">
                No aged batches on hand.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ageingChart} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <XAxis dataKey="band" tick={{ fontSize: 10, fill: MUTED }} axisLine={{ stroke: BORDER }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip
                    contentStyle={{ background: "#FFFFFF", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(value) => [formatCurrency(Number(value) * 100), "Value"]}
                  />
                  <Bar dataKey="ValueSen" radius={[4, 4, 0, 0]} maxBarSize={60}>
                    {ageingChart.map((_, i) => (
                      <Cell key={i} fill={AGE_COLOR[i % AGE_COLOR.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Highest-value raw materials</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                    {["Code", "Description", "Group", "Balance", "Value", "Age"].map((h) => (
                      <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topItems.map((it, i) => (
                    <tr key={it.code ?? i} className="border-b border-[#E2DDD8]">
                      <td className="px-4 py-2 font-mono text-[#1F1D1B]">{it.code ?? "—"}</td>
                      <td className="px-4 py-2 text-[#1F1D1B]">{it.description ?? "—"}</td>
                      <td className="px-4 py-2 text-[#6B7280]">{it.group ?? "—"}</td>
                      <td className="px-4 py-2 tabular-nums text-[#1F1D1B]">{fmtN(it.balanceQty)} {it.uom ?? ""}</td>
                      <td className="px-4 py-2 amount text-[#1F1D1B]">{formatCurrency(it.valueSen)}</td>
                      <td className="px-4 py-2 text-[#6B7280]">{it.oldestDays == null ? "—" : `${it.oldestDays}d`}</td>
                    </tr>
                  ))}
                  {topItems.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-[#6B7280]">No raw materials.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Finished goods on hand</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto" style={{ maxHeight: 440, overflowY: "auto" }}>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-t border-b border-[#E2DDD8] sticky top-0 bg-white">
                    {["Product", "Category", "Available", "Reserved"].map((h) => (
                      <th key={h} className="text-left px-4 py-2 font-semibold uppercase text-[10.5px] tracking-wide text-[#6B7280]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topFG.map((f) => (
                    <tr key={f.code} className="border-b border-[#E2DDD8]">
                      <td className="px-4 py-2 text-[#1F1D1B]">{f.name}</td>
                      <td className="px-4 py-2 text-[#6B7280]">{f.category ?? "—"}</td>
                      <td className="px-4 py-2 tabular-nums text-[#4F7C3A]">{fmtN(f.available)}</td>
                      <td className="px-4 py-2 tabular-nums text-[#9C6F1E]">{fmtN(f.reserved)}</td>
                    </tr>
                  ))}
                  {topFG.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-[#6B7280]">No finished goods on hand.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
