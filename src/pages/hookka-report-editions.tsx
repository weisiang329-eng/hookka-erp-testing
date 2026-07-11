// ===========================================================================
// The Hookka Report — Weekly / Monthly editions.
//
// Rendered inside the Hookka Report module (daily-report.tsx) when the
// Daily/Weekly/Monthly toggle is not on "daily". Same newspaper styling as the
// daily edition; data comes from GET /api/reports/operations.json (collector
// src/api/lib/operations-report.ts), which reuses the system's own calc logic.
// ===========================================================================
import { useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { Loader2, Printer } from "lucide-react";

// Modular product photos (same source as the catalog) — resourceId = baseModel.
type FileRow = { id: string; resourceId?: string; isCover?: boolean };
type FilesResp = FileRow[] | { files?: FileRow[]; data?: FileRow[] };

export type Edition = "daily" | "weekly" | "monthly";

// ── data shapes (mirror src/api/lib/operations-report.ts) ───────────────────

interface TopSeller {
  label: string;
  code: string;
  units: number;
  valueSen: number;
}
interface WorkerEff {
  workerId: string;
  name: string;
  pct: number;
}
interface LowStockItem {
  itemCode: string;
  itemGroup: string;
  balanceQty: number;
  minStock: number;
}
interface DeadStockItem {
  itemCode: string;
  itemGroup: string;
  idleDays: number;
  lastMovement: string;
}
interface PersonChange {
  name: string;
  department: string | null;
}
interface NewProduct {
  category: string;
  code: string;
  name: string;
  baseModel: string | null;
}
interface OperationsReport {
  period: { kind: Edition; startYmd: string; endYmd: string; label: string };
  production: {
    bedframeUnits: number;
    sofaSets: number;
    overdueCount: number;
    onTimePct: number | null;
  };
  productionCost: {
    labourSen: number;
    fabricSen: number;
    foamSen: number;
    otherMaterialSen: number;
    totalSen: number;
  };
  sales: { totalSen: number; orderCount: number; topSellers: TopSeller[] };
  purchasing: {
    poSpendSen: number;
    poCount: number;
    topSuppliers: { name: string; spendSen: number }[];
  };
  material: {
    fabricConsumedSen: number;
    foamConsumedSen: number;
    otherConsumedSen: number;
    fabricMetres: number;
    fabricCostPerMetreSen: number | null;
    byGroup: { itemGroup: string; consumedSen: number }[];
  };
  workforce: {
    activeWorkers: number | null;
    bonusEarned: number | null;
    attendancePct: number | null;
    serviceOpen: number;
    topEfficiency: WorkerEff[];
    bottomEfficiency: WorkerEff[];
  };
  inventory: {
    rmStockValueSen: number;
    lowStockCount: number;
    lowStock: LowStockItem[];
    deadStock: DeadStockItem[];
  };
  people: { joined: PersonChange[]; left: PersonChange[] };
  newProducts: NewProduct[];
  delivery: {
    producedToDispatchDays: number | null;
    dispatchToDeliveredDays: number | null;
    onTimePct: number | null;
    stuckOver5Count: number;
    sampleSize: number;
  };
  receivables: {
    aging: {
      currentSen: number;
      d30Sen: number;
      d60Sen: number;
      d90Sen: number;
      over90Sen: number;
    };
    totalOutstandingSen: number;
    billedSen: number;
    collectedSen: number;
  };
  quality: { defectPct: number | null; inspected: number };
  supplier: { onTimePct: number | null; sampleSize: number };
  priceAlerts: { materialCode: string; pctChange: number }[];
  deptCost: {
    month: string;
    byDept: { dept: string; sen: number }[];
    highestDept: string | null;
    productionSen: number;
    nonProductionSen: number;
  };
}
type Resp = { success?: boolean; data?: OperationsReport };

// ── formatting ──────────────────────────────────────────────────────────────

function rm(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", { maximumFractionDigits: 0 });
}
function rmK(sen: number): string {
  const v = sen / 100;
  if (Math.abs(v) >= 1000)
    return "RM " + (v / 1000).toLocaleString("en-MY", { maximumFractionDigits: 1 }) + "k";
  return "RM " + v.toLocaleString("en-MY", { maximumFractionDigits: 0 });
}

// ── toggle ──────────────────────────────────────────────────────────────────

export function EditionToggle({
  edition,
  onChange,
}: {
  edition: Edition;
  onChange: (e: Edition) => void;
}) {
  const opts: Edition[] = ["daily", "weekly", "monthly"];
  return (
    <div className="flex justify-center print:hidden">
      <div className="inline-flex overflow-hidden rounded-md border border-[#1F1D1B]">
        {opts.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={`px-5 py-1.5 font-serif text-sm font-bold uppercase tracking-[0.14em] transition-colors ${
              edition === o
                ? "bg-[#1F1D1B] text-[#FAF8F4]"
                : "bg-transparent text-[#1F1D1B] hover:bg-[#F0ECE9]"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── small building blocks (newspaper style) ─────────────────────────────────

function Desk({
  desk,
  headline,
  children,
}: {
  desk: string;
  headline: string;
  children: React.ReactNode;
}) {
  return (
    <article className="break-inside-avoid border-t-2 border-[#1F1D1B] pt-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#9A3A2D]">
        {desk}
      </p>
      <h3 className="mt-0.5 font-serif text-lg font-bold leading-tight text-[#1F1D1B]">
        {headline}
      </h3>
      <div className="mt-1.5">{children}</div>
    </article>
  );
}

function Rows({
  rows,
}: {
  rows: [React.ReactNode, React.ReactNode][];
}) {
  return (
    <dl className="space-y-0.5">
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-2 border-b border-[#E4DCCB] py-1 text-[12.5px]"
        >
          <dt className="text-[#4B463F]">{r[0]}</dt>
          <dd className="shrink-0 font-semibold tabular-nums text-[#1F1D1B]">
            {r[1]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── edition ─────────────────────────────────────────────────────────────────

export function OperationsEdition({
  edition,
  anchorYmd,
}: {
  edition: Edition;
  anchorYmd: string;
}) {
  const { data: raw, loading } = useCachedJson<Resp>(
    `/api/reports/operations.json?period=${edition}&date=${anchorYmd}`,
  );
  const r = raw?.data ?? null;

  // baseModel → representative photo file id (cover preferred).
  const { data: filesRaw } = useCachedJson<FilesResp>(
    "/api/files?resourceType=modular",
  );
  const photoByModel = useMemo(() => {
    const list: FileRow[] = Array.isArray(filesRaw)
      ? filesRaw
      : (filesRaw?.files ?? filesRaw?.data ?? []);
    const map = new Map<string, string>();
    for (const f of list) {
      const rid = f.resourceId;
      if (!rid || !f.id) continue;
      if (!map.has(rid) || f.isCover) map.set(rid, f.id);
    }
    return map;
  }, [filesRaw]);

  if (loading && !r) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
      </div>
    );
  }
  if (!r) {
    return (
      <div className="border border-[#E2DDD8] bg-[#FAF8F4] p-8 text-center text-sm text-[#6B7280]">
        Could not build this edition. Please try again.
      </div>
    );
  }

  const editionName = edition === "weekly" ? "Weekly Edition" : "Monthly Edition";
  const units = r.production.bedframeUnits + r.production.sofaSets;
  const isMonthly = edition === "monthly";

  const leadHeadline = `${units} Units Off the Floor · On-Time at ${
    r.production.onTimePct == null ? "—" : r.production.onTimePct + "%"
  }`;
  const leadBody =
    `The ${edition === "weekly" ? "week" : "month"} booked ${rmK(r.sales.totalSen)} in sales ` +
    `against ${rmK(r.productionCost.totalSen)} of production cost. ` +
    `${r.production.overdueCount} orders sit overdue, and ${rmK(
      r.receivables.totalOutstandingSen,
    )} remains outstanding` +
    (r.receivables.aging.over90Sen > 0
      ? ` — ${rmK(r.receivables.aging.over90Sen)} of it past ninety days.`
      : ".");

  const byTheNumbers: [string, React.ReactNode][] = [
    ["On-time delivery", r.production.onTimePct == null ? "—" : `${r.production.onTimePct}%`],
    ["Units completed", units],
    ["Production cost", rmK(r.productionCost.totalSen)],
    ["Sales", rmK(r.sales.totalSen)],
    ["Receivables", rmK(r.receivables.totalOutstandingSen)],
    ["Overdue orders", r.production.overdueCount],
    ["RM stock value", rmK(r.inventory.rmStockValueSen)],
  ];

  return (
    <div className="space-y-6">
      {/* masthead */}
      <header className="border-y-[3px] border-double border-[#1F1D1B] py-3">
        <div className="flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B7280]">
          <span>Hookka Manufacturing</span>
          <span className="hidden sm:inline">{editionName}</span>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 hover:text-[#1F1D1B] print:hidden"
          >
            <Printer className="h-3 w-3" /> Print
          </button>
        </div>
        <h1 className="mt-1 text-center font-serif text-4xl font-black tracking-tight text-[#1F1D1B] sm:text-5xl">
          The Hookka Report
        </h1>
        <div className="mt-1 flex items-center justify-center gap-3 border-t border-[#1F1D1B] pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6B7280]">
          <span>{r.period.label}</span>
          <span className="text-[#C9A24B]">◆</span>
          <span>
            {r.period.startYmd} – {r.period.endYmd}
          </span>
        </div>
      </header>

      {/* front page: lead + by the numbers */}
      <div className="grid gap-6 lg:grid-cols-3">
        <article className="border-b-2 border-[#1F1D1B] pb-5 lg:col-span-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#9A3A2D]">
            Production Desk · Lead Story
          </p>
          <h2 className="mt-1 font-serif text-3xl font-black leading-[1.1] text-[#1F1D1B] sm:text-4xl">
            {leadHeadline}
          </h2>
          <p className="mt-2 font-serif text-[15px] leading-relaxed text-[#3A352F]">
            <span className="float-left mr-2 font-serif text-5xl font-black leading-[0.8] text-[#1F1D1B]">
              {leadBody.charAt(0)}
            </span>
            {leadBody.slice(1)}
          </p>
          <div className="mt-3">
            <Rows
              rows={[
                ["Bedframe units", r.production.bedframeUnits],
                ["Sofa sets", r.production.sofaSets],
                [
                  "Labour cost",
                  `RM ${rm(r.productionCost.labourSen)}`,
                ],
                ["Fabric cost", `RM ${rm(r.productionCost.fabricSen)}`],
              ]}
            />
          </div>
        </article>

        <aside className="h-fit border border-[#1F1D1B] bg-[#FAF8F4] p-4">
          <p className="border-b border-[#1F1D1B] pb-1 text-center font-serif text-sm font-bold uppercase tracking-wide text-[#1F1D1B]">
            By the Numbers
          </p>
          <dl className="mt-2 space-y-1">
            {byTheNumbers.map(([k, v], i) => (
              <div
                key={i}
                className="flex items-baseline justify-between gap-2 text-[12px]"
              >
                <dt className="truncate text-[#6B7280]">{k}</dt>
                <dd className="shrink-0 font-bold tabular-nums text-[#1F1D1B]">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>

      {/* desks */}
      <div className="columns-1 gap-6 sm:columns-2 lg:columns-3 [&>*]:mb-6 [&>*]:break-inside-avoid">
        <Desk desk="Logistics Desk" headline="Delivery Flow">
          <Rows
            rows={[
              [
                "Produced → dispatched",
                r.delivery.producedToDispatchDays == null
                  ? "—"
                  : `${r.delivery.producedToDispatchDays} d`,
              ],
              [
                "Dispatched → delivered",
                r.delivery.dispatchToDeliveredDays == null
                  ? "—"
                  : `${r.delivery.dispatchToDeliveredDays} d`,
              ],
              [
                "On-time",
                r.delivery.onTimePct == null ? "—" : `${r.delivery.onTimePct}%`,
              ],
              ["Stuck > 5 days after production", r.delivery.stuckOver5Count],
            ]}
          />
        </Desk>

        <Desk desk="Workforce Desk" headline="Efficiency & Bonus">
          <Rows
            rows={[
              ["Active workers", r.workforce.activeWorkers ?? "—"],
              [
                "Earned efficiency bonus",
                r.workforce.activeWorkers != null
                  ? `${r.workforce.bonusEarned ?? 0} / ${r.workforce.activeWorkers}`
                  : (r.workforce.bonusEarned ?? "—"),
              ],
              [
                "Attendance",
                r.workforce.attendancePct == null
                  ? "—"
                  : `${r.workforce.attendancePct}%`,
              ],
              [
                "Open service cases",
                <span className={r.workforce.serviceOpen > 0 ? "text-[#9A3A2D]" : ""}>
                  {r.workforce.serviceOpen}
                </span>,
              ],
              [
                "QC defect rate",
                r.quality.defectPct == null
                  ? "—"
                  : `${r.quality.defectPct}% · ${r.quality.inspected} checked`,
              ],
            ]}
          />
          {r.workforce.topEfficiency.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                Top efficiency
              </p>
              <Rows
                rows={r.workforce.topEfficiency.map((w) => [
                  w.name,
                  `${w.pct}%`,
                ])}
              />
            </>
          )}
          {r.workforce.bottomEfficiency.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                Needs attention
              </p>
              <Rows
                rows={r.workforce.bottomEfficiency.map((w) => [
                  w.name,
                  <span className="text-[#9A3A2D]">{w.pct}%</span>,
                ])}
              />
            </>
          )}
        </Desk>

        <Desk desk="Sales Desk" headline="Sales & Top Sellers">
          <Rows
            rows={[
              ["Total sales", `RM ${rm(r.sales.totalSen)}`],
              ["Orders", r.sales.orderCount],
            ]}
          />
          {r.sales.topSellers.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                Top sellers
              </p>
              <Rows
                rows={r.sales.topSellers.map((t) => [
                  t.label,
                  `${t.units} · RM ${rm(t.valueSen)}`,
                ])}
              />
            </>
          )}
        </Desk>

        <Desk desk="Procurement Desk" headline="Purchasing">
          <Rows
            rows={[
              ["PO spend", `RM ${rm(r.purchasing.poSpendSen)}`],
              ["PO count", r.purchasing.poCount],
              [
                "Supplier on-time",
                r.supplier.onTimePct == null
                  ? "—"
                  : `${r.supplier.onTimePct}%`,
              ],
            ]}
          />
          {r.priceAlerts.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#9A3A2D]">
                Price watch · rises
              </p>
              <Rows
                rows={r.priceAlerts.map((a) => [
                  a.materialCode,
                  <span className="text-[#9A3A2D]">▲ {a.pctChange}%</span>,
                ])}
              />
            </>
          )}
          {r.purchasing.topSuppliers.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                Top suppliers
              </p>
              <Rows
                rows={r.purchasing.topSuppliers.map((s) => [
                  s.name,
                  `RM ${rm(s.spendSen)}`,
                ])}
              />
            </>
          )}
        </Desk>

        <Desk desk="Billing Desk" headline="Receivables">
          <div className="mb-2 grid grid-cols-4 border border-[#1F1D1B] text-center">
            {[
              ["Current", r.receivables.aging.currentSen, ""],
              ["31–60d", r.receivables.aging.d60Sen, ""],
              ["61–90d", r.receivables.aging.d90Sen, "text-[#8A6A15]"],
              ["90d+", r.receivables.aging.over90Sen, "text-[#9A3A2D]"],
            ].map(([lab, val, cls], i) => (
              <div
                key={i}
                className={`px-1 py-1.5 ${i < 3 ? "border-r border-[#D8CFB9]" : ""}`}
              >
                <div className="text-[9px] uppercase text-[#6B7280]">{lab as string}</div>
                <div className={`text-[13px] font-bold tabular-nums ${cls as string}`}>
                  {rmK(val as number)}
                </div>
              </div>
            ))}
          </div>
          <Rows
            rows={[
              ["Billed this period", `RM ${rm(r.receivables.billedSen)}`],
              ["Collected this period", `RM ${rm(r.receivables.collectedSen)}`],
            ]}
          />
        </Desk>

        <Desk desk="Inventory Desk" headline="Stock & Dead Stock">
          <Rows
            rows={[
              ["RM stock value", `RM ${rm(r.inventory.rmStockValueSen)}`],
              [
                "Low-stock items",
                <span className={r.inventory.lowStockCount > 0 ? "text-[#9A3A2D]" : ""}>
                  {r.inventory.lowStockCount}
                </span>,
              ],
            ]}
          />
          {r.inventory.deadStock.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                Dead stock · idle days
              </p>
              <Rows
                rows={r.inventory.deadStock.map((d) => [
                  d.itemCode,
                  `${d.idleDays} d`,
                ])}
              />
            </>
          )}
        </Desk>

        <Desk desk="Data Desk" headline="Material Usage">
          <Rows
            rows={[
              [
                "Fabric consumed",
                `${r.material.fabricMetres.toLocaleString("en-MY", {
                  maximumFractionDigits: 0,
                })} m`,
              ],
              [
                "Fabric cost / metre",
                r.material.fabricCostPerMetreSen == null
                  ? "—"
                  : `RM ${rm(r.material.fabricCostPerMetreSen)}`,
              ],
              ["Foam consumed", `RM ${rm(r.material.foamConsumedSen)}`],
            ]}
          />
          {r.material.byGroup.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
                By category · cost
              </p>
              <Rows
                rows={r.material.byGroup
                  .slice(0, 5)
                  .map((g) => [g.itemGroup, `RM ${rm(g.consumedSen)}`])}
              />
            </>
          )}
        </Desk>

        {r.deptCost.byDept.length > 0 && (
          <Desk desk="Cost Desk" headline="Department Cost">
            <p className="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-[#8A8171]">
              Payroll ({r.deptCost.month}) · highest:{" "}
              <b className="text-[#1F1D1B]">{r.deptCost.highestDept ?? "—"}</b>
            </p>
            <Rows
              rows={[
                ["Production depts", `RM ${rm(r.deptCost.productionSen)}`],
                ["Non-production", `RM ${rm(r.deptCost.nonProductionSen)}`],
              ]}
            />
            <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
              By department
            </p>
            <Rows
              rows={r.deptCost.byDept
                .slice(0, 6)
                .map((d) => [d.dept, `RM ${rm(d.sen)}`])}
            />
          </Desk>
        )}

        {isMonthly && (
          <Desk desk="People Desk" headline="Who Joined, Who Left">
            <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
              Joined — {r.people.joined.length}
            </p>
            {r.people.joined.length === 0 ? (
              <p className="py-1 text-[12px] italic text-[#8A8171]">None</p>
            ) : (
              <Rows
                rows={r.people.joined.map((p) => [p.name, p.department ?? ""])}
              />
            )}
            <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B5C32]">
              Left — {r.people.left.length}
            </p>
            {r.people.left.length === 0 ? (
              <p className="py-1 text-[12px] italic text-[#8A8171]">None</p>
            ) : (
              <Rows rows={r.people.left.map((p) => [p.name, p.department ?? ""])} />
            )}
          </Desk>
        )}

        {isMonthly && (
          <Desk desk="R&D Desk" headline="New Products This Month">
            {r.newProducts.length === 0 ? (
              <p className="py-1 text-[12px] italic text-[#8A8171]">
                None recorded. Products created before this feature don't carry a
                creation date.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {r.newProducts.map((np) => {
                  const fileId = np.baseModel
                    ? photoByModel.get(np.baseModel)
                    : undefined;
                  return (
                    <div
                      key={np.code}
                      className="border border-[#E4DCCB] rounded overflow-hidden"
                    >
                      <div className="h-16 bg-[#F4EFE3] flex items-center justify-center overflow-hidden">
                        {fileId ? (
                          <img
                            src={`/api/files/${fileId}/download`}
                            alt={np.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-[#C9BEA6] text-lg">▦</span>
                        )}
                      </div>
                      <div className="px-1.5 py-1">
                        <div className="font-mono text-[11px] font-bold text-[#1F1D1B] truncate">
                          {np.code}
                        </div>
                        <div className="text-[10px] text-[#6B7280] truncate">
                          {np.category}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Desk>
        )}
      </div>
    </div>
  );
}
