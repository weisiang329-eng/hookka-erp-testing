// ---------------------------------------------------------------------------
// Operations Report — the "newspaper". Daily / Weekly / Monthly, one page,
// rendered from GET /api/reports/operations.json. Broadsheet styling (serif
// masthead, ruled section kickers, column flow) using the app palette so it
// feels native but reads like a printed report. All numbers come from the
// backend collector, which reuses the system's own calc logic.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { cachedFetchJson } from "@/lib/cached-fetch";
import { Button } from "@/components/ui/button";
import { Loader2, Printer } from "lucide-react";

type PeriodKind = "daily" | "weekly" | "monthly";

interface ResolvedPeriod {
  kind: PeriodKind;
  startYmd: string;
  endYmd: string;
  anchorYmd: string;
  label: string;
}
interface TopSeller {
  label: string;
  code: string;
  units: number;
  valueSen: number;
}
interface SupplierSpend {
  name: string;
  spendSen: number;
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
  period: ResolvedPeriod;
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
    topSuppliers: SupplierSpend[];
  };
  material: {
    fabricConsumedSen: number;
    foamConsumedSen: number;
    otherConsumedSen: number;
    fabricMetres: number;
    fabricCostPerMetreSen: number | null;
  };
  workforce: {
    activeWorkers: number | null;
    bonusEarned: number | null;
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
}

// -- formatting -------------------------------------------------------------

function rm(sen: number): string {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}
function rmK(sen: number): string {
  const v = sen / 100;
  if (Math.abs(v) >= 1000)
    return (v / 1000).toLocaleString("en-MY", { maximumFractionDigits: 1 }) + "k";
  return v.toLocaleString("en-MY", { maximumFractionDigits: 0 });
}
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// -- small presentational pieces --------------------------------------------

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="ops-kicker">{children}</div>;
}
function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "danger" | "warn";
}) {
  return (
    <div className="ops-stat">
      <div className="ops-stat-l">{label}</div>
      <div
        className="ops-stat-v"
        style={
          tone === "danger"
            ? { color: "#9B2915" }
            : tone === "warn"
              ? { color: "#8A6A15" }
              : undefined
        }
      >
        {value}
      </div>
      {sub && <div className="ops-stat-s">{sub}</div>}
    </div>
  );
}

export default function OperationsReportTab() {
  const [period, setPeriod] = useState<PeriodKind>("monthly");
  const [date, setDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await cachedFetchJson<{
        success: boolean;
        data?: OperationsReport;
      }>(`/api/reports/operations.json?period=${period}&date=${date}`);
      if (json?.success && json.data) setReport(json.data);
      else setError("Could not generate the report.");
    } catch {
      setError("Could not generate the report.");
    }
    setLoading(false);
  }, [period, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const isMonthly = period === "monthly";
  const materialTotal = useMemo(() => {
    if (!report) return 0;
    return (
      report.material.fabricConsumedSen +
      report.material.foamConsumedSen +
      report.material.otherConsumedSen
    );
  }, [report]);

  return (
    <div className="space-y-4">
      <style>{OPS_CSS}</style>

      {/* controls (hidden on print) */}
      <div className="ops-controls">
        <div className="ops-seg">
          {(["daily", "weekly", "monthly"] as PeriodKind[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={period === p ? "active" : ""}
            >
              {p === "daily" ? "Daily" : p === "weekly" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ops-date"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.print()}
          disabled={!report}
        >
          <Printer className="h-3.5 w-3.5" /> Print / PDF
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
          <span className="ml-3 text-[#6B7280]">Setting the numbers…</span>
        </div>
      )}
      {error && !loading && (
        <div className="py-16 text-center text-[#9B2915]">{error}</div>
      )}

      {report && !loading && (
        <div className="ops-print-root">
          <div className="ops-paper">
            {/* masthead */}
            <div className="ops-folio-top">
              <span>Batu Pahat</span>
              <span>Internal Circulation Only</span>
              <span>Operations</span>
            </div>
            <div className="ops-masthead">
              <div className="ops-nameplate">Hookka Industries</div>
              <div className="ops-subplate">
                {period === "daily"
                  ? "Daily Report"
                  : period === "weekly"
                    ? "Weekly Operations Report"
                    : "Monthly Operations Report"}
              </div>
              <div className="ops-folio">
                {report.period.label}
                {period !== "daily" &&
                  ` · ${report.period.startYmd} – ${report.period.endYmd}`}
              </div>
            </div>

            {/* headline stats */}
            <div className="ops-kpis">
              <Stat
                label="On-time delivery"
                value={
                  report.production.onTimePct == null
                    ? "—"
                    : `${report.production.onTimePct}%`
                }
              />
              <Stat
                label="Units completed"
                value={report.production.bedframeUnits + report.production.sofaSets}
                sub={`${report.production.bedframeUnits} bf · ${report.production.sofaSets} sofa`}
              />
              <Stat
                label="Production cost"
                value={rmK(report.productionCost.totalSen)}
                sub="RM"
              />
              <Stat label="Sales" value={rmK(report.sales.totalSen)} sub="RM" />
              <Stat
                label="Receivables"
                value={rmK(report.receivables.totalOutstandingSen)}
                sub="RM outstanding"
                tone="danger"
              />
              <Stat
                label="Overdue"
                value={report.production.overdueCount}
                tone={report.production.overdueCount > 0 ? "danger" : undefined}
              />
            </div>

            {/* body columns */}
            <div className="ops-columns">
              {/* Production */}
              <section>
                <Kicker>Production</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Bedframe units</td>
                      <td className="n">{report.production.bedframeUnits}</td>
                    </tr>
                    <tr>
                      <td>Sofa sets</td>
                      <td className="n">{report.production.sofaSets}</td>
                    </tr>
                    <tr>
                      <td>Overdue orders</td>
                      <td className="n">{report.production.overdueCount}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="ops-subhd">Cost breakdown</div>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Labour</td>
                      <td className="n">{rm(report.productionCost.labourSen)}</td>
                    </tr>
                    <tr>
                      <td>Fabric</td>
                      <td className="n">{rm(report.productionCost.fabricSen)}</td>
                    </tr>
                    <tr>
                      <td>Foam</td>
                      <td className="n">{rm(report.productionCost.foamSen)}</td>
                    </tr>
                    <tr>
                      <td>Other material</td>
                      <td className="n">
                        {rm(report.productionCost.otherMaterialSen)}
                      </td>
                    </tr>
                    <tr className="tot">
                      <td>Total</td>
                      <td className="n">{rm(report.productionCost.totalSen)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              {/* Delivery */}
              <section>
                <Kicker>Delivery flow</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Produced → dispatched</td>
                      <td className="n">
                        {report.delivery.producedToDispatchDays == null
                          ? "—"
                          : `${report.delivery.producedToDispatchDays} d`}
                      </td>
                    </tr>
                    <tr>
                      <td>Dispatched → delivered</td>
                      <td className="n">
                        {report.delivery.dispatchToDeliveredDays == null
                          ? "—"
                          : `${report.delivery.dispatchToDeliveredDays} d`}
                      </td>
                    </tr>
                    <tr>
                      <td>On-time %</td>
                      <td className="n">
                        {report.delivery.onTimePct == null
                          ? "—"
                          : `${report.delivery.onTimePct}%`}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {report.delivery.stuckOver5Count > 0 && (
                  <div className="ops-callout">
                    {report.delivery.stuckOver5Count} orders sat &gt;5 days after
                    production before shipment.
                  </div>
                )}
              </section>

              {/* Workforce */}
              <section>
                <Kicker>Workforce</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Active workers</td>
                      <td className="n">{report.workforce.activeWorkers ?? "—"}</td>
                    </tr>
                    <tr>
                      <td>Bonus earned</td>
                      <td className="n">
                        {report.workforce.bonusEarned ?? "—"}
                        {report.workforce.activeWorkers != null &&
                          ` / ${report.workforce.activeWorkers}`}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {report.workforce.topEfficiency.length > 0 && (
                  <>
                    <div className="ops-subhd">
                      {period === "daily" ? "Today's efficiency" : "Top efficiency"}
                    </div>
                    <table className="ops-tbl">
                      <tbody>
                        {report.workforce.topEfficiency.map((w) => (
                          <tr key={w.workerId}>
                            <td>{w.name}</td>
                            <td className="n">{w.pct}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                {period !== "daily" &&
                  report.workforce.bottomEfficiency.length > 0 && (
                    <>
                      <div className="ops-subhd">Needs attention</div>
                      <table className="ops-tbl">
                        <tbody>
                          {report.workforce.bottomEfficiency.map((w) => (
                            <tr key={w.workerId}>
                              <td>{w.name}</td>
                              <td className="n" style={{ color: "#9B2915" }}>
                                {w.pct}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
              </section>

              {/* Sales */}
              <section>
                <Kicker>Sales</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Total sales</td>
                      <td className="n">{rm(report.sales.totalSen)}</td>
                    </tr>
                    <tr>
                      <td>Orders</td>
                      <td className="n">{report.sales.orderCount}</td>
                    </tr>
                  </tbody>
                </table>
                {report.sales.topSellers.length > 0 && (
                  <>
                    <div className="ops-subhd">Top sellers</div>
                    <table className="ops-tbl">
                      <tbody>
                        {report.sales.topSellers.map((t) => (
                          <tr key={t.code}>
                            <td>{t.label}</td>
                            <td className="n">
                              {t.units} · {rm(t.valueSen)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>

              {/* Purchasing */}
              <section>
                <Kicker>Purchasing</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>PO spend</td>
                      <td className="n">{rm(report.purchasing.poSpendSen)}</td>
                    </tr>
                    <tr>
                      <td>PO count</td>
                      <td className="n">{report.purchasing.poCount}</td>
                    </tr>
                  </tbody>
                </table>
                {report.purchasing.topSuppliers.length > 0 && (
                  <>
                    <div className="ops-subhd">Top suppliers</div>
                    <table className="ops-tbl">
                      <tbody>
                        {report.purchasing.topSuppliers.map((s, i) => (
                          <tr key={i}>
                            <td>{s.name}</td>
                            <td className="n">{rm(s.spendSen)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>

              {/* Receivables */}
              <section>
                <Kicker>Receivables</Kicker>
                <div className="ops-aging">
                  <div>
                    <div className="al">Current</div>
                    <div className="av">{rmK(report.receivables.aging.currentSen)}</div>
                  </div>
                  <div>
                    <div className="al">31–60d</div>
                    <div className="av">{rmK(report.receivables.aging.d60Sen)}</div>
                  </div>
                  <div>
                    <div className="al">61–90d</div>
                    <div className="av" style={{ color: "#8A6A15" }}>
                      {rmK(report.receivables.aging.d90Sen)}
                    </div>
                  </div>
                  <div>
                    <div className="al">90d +</div>
                    <div className="av" style={{ color: "#9B2915" }}>
                      {rmK(report.receivables.aging.over90Sen)}
                    </div>
                  </div>
                </div>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Billed this period</td>
                      <td className="n">{rm(report.receivables.billedSen)}</td>
                    </tr>
                    <tr>
                      <td>Collected this period</td>
                      <td className="n">{rm(report.receivables.collectedSen)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              {/* Inventory */}
              <section>
                <Kicker>Inventory</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>RM stock value</td>
                      <td className="n">{rm(report.inventory.rmStockValueSen)}</td>
                    </tr>
                    <tr>
                      <td>Low-stock items</td>
                      <td className="n" style={{ color: "#9B2915" }}>
                        {report.inventory.lowStockCount}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {report.inventory.lowStock.length > 0 && (
                  <>
                    <div className="ops-subhd">Reorder now</div>
                    <table className="ops-tbl">
                      <tbody>
                        {report.inventory.lowStock.slice(0, 6).map((it) => (
                          <tr key={it.itemCode}>
                            <td>{it.itemCode}</td>
                            <td className="n">
                              {it.balanceQty} / {it.minStock}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                {report.inventory.deadStock.length > 0 && (
                  <>
                    <div className="ops-subhd">Dead stock · idle days</div>
                    <table className="ops-tbl">
                      <tbody>
                        {report.inventory.deadStock.map((it) => (
                          <tr key={it.itemCode}>
                            <td>{it.itemCode}</td>
                            <td className="n">{it.idleDays} d</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>

              {/* Material */}
              <section>
                <Kicker>Material</Kicker>
                <table className="ops-tbl">
                  <tbody>
                    <tr>
                      <td>Fabric consumed</td>
                      <td className="n">
                        {report.material.fabricMetres.toLocaleString("en-MY", {
                          maximumFractionDigits: 0,
                        })}{" "}
                        m
                      </td>
                    </tr>
                    <tr>
                      <td>Fabric cost / metre</td>
                      <td className="n">
                        {report.material.fabricCostPerMetreSen == null
                          ? "—"
                          : rm(report.material.fabricCostPerMetreSen)}
                      </td>
                    </tr>
                    <tr>
                      <td>Foam consumed</td>
                      <td className="n">{rm(report.material.foamConsumedSen)}</td>
                    </tr>
                    <tr className="tot">
                      <td>Total consumed</td>
                      <td className="n">{rm(materialTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              {/* People — monthly only */}
              {isMonthly && (
                <section>
                  <Kicker>People changes</Kicker>
                  <div className="ops-subhd">Joined — {report.people.joined.length}</div>
                  {report.people.joined.length === 0 ? (
                    <div className="ops-empty">None</div>
                  ) : (
                    <table className="ops-tbl">
                      <tbody>
                        {report.people.joined.map((pn, i) => (
                          <tr key={i}>
                            <td>{pn.name}</td>
                            <td className="n">{pn.department ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="ops-subhd">Left — {report.people.left.length}</div>
                  {report.people.left.length === 0 ? (
                    <div className="ops-empty">None</div>
                  ) : (
                    <table className="ops-tbl">
                      <tbody>
                        {report.people.left.map((pn, i) => (
                          <tr key={i}>
                            <td>{pn.name}</td>
                            <td className="n">{pn.department ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )}

              {/* New products — monthly only */}
              {isMonthly && (
                <section>
                  <Kicker>New products</Kicker>
                  {report.newProducts.length === 0 ? (
                    <div className="ops-empty">
                      None recorded this month. (Products created before this
                      feature don't carry a creation date.)
                    </div>
                  ) : (
                    <table className="ops-tbl">
                      <tbody>
                        {report.newProducts.map((np) => (
                          <tr key={np.code}>
                            <td>
                              <b>{np.code}</b>
                              <br />
                              <span style={{ color: "#6B7280", fontSize: 11 }}>
                                {np.name}
                              </span>
                            </td>
                            <td className="n">{np.category}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )}
            </div>

            <div className="ops-endrule">
              Hookka Industries · {report.period.label} · End of Edition
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const OPS_CSS = `
.ops-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ops-seg{display:inline-flex;border:1px solid #E2DDD8;border-radius:8px;overflow:hidden}
.ops-seg button{padding:6px 14px;font-size:13px;background:#fff;border:0;cursor:pointer;color:#6B7280}
.ops-seg button.active{background:#6B5C32;color:#fff}
.ops-date{border:1px solid #E2DDD8;border-radius:6px;padding:6px 10px;font-size:13px;color:#1F1D1B}
.ops-paper{background:#F7F4EC;color:#1B1712;border:1px solid #E2DDD8;border-radius:10px;
  padding:24px 28px 34px;max-width:920px;margin:0 auto;
  font-family:Georgia,'Times New Roman',serif}
.ops-folio-top{display:flex;justify-content:space-between;font-family:Arial,'Helvetica Neue',sans-serif;
  text-transform:uppercase;letter-spacing:1.2px;font-size:10px;color:#6B5C32;
  padding-bottom:7px;border-bottom:1px solid #D8CFB9}
.ops-masthead{text-align:center;padding:12px 0 8px;border-bottom:3px double #1B1712}
.ops-nameplate{font-weight:700;font-size:clamp(30px,6vw,58px);line-height:1;letter-spacing:-0.5px}
.ops-subplate{font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:5px;
  font-size:12px;font-weight:700;color:#9B2915;margin-top:8px}
.ops-folio{font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:1.2px;
  font-size:11px;color:#6B7280;margin-top:6px}
.ops-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
  background:#D8CFB9;border:1px solid #D8CFB9;margin:16px 0;border-radius:6px;overflow:hidden}
.ops-stat{background:#F7F4EC;padding:10px 12px}
.ops-stat-l{font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.5px;
  font-size:10px;color:#6B7280}
.ops-stat-v{font-weight:700;font-size:21px;margin-top:3px;font-variant-numeric:tabular-nums}
.ops-stat-s{font-family:Arial,sans-serif;font-size:10.5px;color:#8A8171;margin-top:2px}
.ops-columns{column-count:2;column-gap:28px;column-rule:1px solid #D8CFB9;margin-top:18px}
.ops-columns > section{break-inside:avoid;-webkit-column-break-inside:avoid;margin:0 0 20px;display:block}
.ops-kicker{display:flex;align-items:center;gap:8px;font-family:Arial,sans-serif;
  text-transform:uppercase;letter-spacing:2px;font-size:11px;font-weight:700;margin-bottom:8px;color:#1B1712}
.ops-kicker::before,.ops-kicker::after{content:"";flex:1;height:0;border-top:1px solid #1B1712}
.ops-subhd{font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.8px;
  font-size:10px;color:#6B5C32;margin:9px 0 3px;font-weight:700}
.ops-tbl{width:100%;border-collapse:collapse;font-family:Arial,'Helvetica Neue',sans-serif;font-size:12.5px}
.ops-tbl td{padding:3.5px 0;border-bottom:1px solid #E4DCCB;color:#2C2A26;vertical-align:top}
.ops-tbl td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:8px}
.ops-tbl tr.tot td{border-top:1.5px solid #1B1712;border-bottom:none;font-weight:700;color:#1B1712}
.ops-callout{border:1px solid #9B2915;background:#FBEEEA;color:#7a230f;font-size:12px;
  padding:7px 9px;margin-top:8px;font-style:italic}
.ops-aging{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #1B1712;margin-bottom:6px}
.ops-aging > div{padding:6px 4px;border-right:1px solid #D8CFB9;text-align:center}
.ops-aging > div:last-child{border-right:none}
.ops-aging .al{font-family:Arial,sans-serif;text-transform:uppercase;font-size:9px;color:#6B7280}
.ops-aging .av{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;margin-top:2px}
.ops-empty{font-family:Arial,sans-serif;font-size:11.5px;color:#8A8171;font-style:italic;padding:4px 0}
.ops-endrule{border-top:3px double #1B1712;margin-top:6px;padding-top:12px;text-align:center;
  font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:2px;font-size:10px;color:#8A8171}
@media (max-width:680px){.ops-columns{column-count:1}}
@media print{
  body * {visibility:hidden !important}
  .ops-print-root, .ops-print-root * {visibility:visible !important}
  .ops-print-root{position:absolute;left:0;top:0;width:100%}
  .ops-paper{border:0;max-width:100%}
}
`;
