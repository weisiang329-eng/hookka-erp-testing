// ---------------------------------------------------------------------------
// OcrAccuracyCard — a Dashboard block (owner 2026-07-04). Shows the OCR
// success rate (upload → did the operator change anything? changed = fail) so
// the owner knows which customer / supplier is safe to automate (Gmail →
// auto-draft → auto-confirm needs ~100%). Data: GET /api/ocr-accuracy.
// Self-contained (own fetch) so it drops into the dashboard with one line.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useCachedJson, isUnknownOutcome } from "@/lib/cached-fetch";
import { AlertTriangle, ChevronRight, ChevronDown, RefreshCw, ScanLine } from "lucide-react";

type Bucket = {
  key: string;
  total: number;
  success: number;
  rate: number | null;
  // What `total` counted. A customer row counts DOCUMENTS (imported POs) while
  // its expanded category rows count LINES on those POs, so the two levels
  // legitimately disagree — the parent 'PO' row read 59 while its children read
  // 87 + 4 + 1 = 92 under one "Scans" header (owner 2026-08-05). Never render a
  // total without its unit.
  unit?: "documents" | "lines";
  topFails: string[];
  children?: Bucket[];
};
type Resp = {
  success?: boolean;
  data?: {
    overall: { total: number; success: number; rate: number | null };
    salesOrders: Bucket & { customers: Bucket[] };
    supplier: Bucket & { suppliers: Bucket[]; docTypes?: Bucket[] };
    // Owner 2026-08-01: 「要有平均 scan 一张 PO/PI/GR 的时间」. Enqueue → done,
    // i.e. what the operator actually waits through. Cache hits excluded.
    timing?: {
      totalScans: number;
      buckets: { key: string; scans: number; avgSec: number | null; p90Sec: number | null }[];
    };
  };
};

/**
 * Below this many documents a rate is noise, not a measurement.
 *
 * Owner 2026-08-05: the Supplier panel read a red 0% off ONE document. One
 * edited field on one scan is 0%, one clean scan is 100%, and neither says
 * anything about the scanner. Shown greyed with the sample size instead, so a
 * thin month reads as "not enough to judge" rather than "broken".
 */
const MIN_SAMPLE = 5;

function rateColor(rate: number | null, total?: number): string {
  if (rate === null) return "#9CA3AF";
  if (total !== undefined && total < MIN_SAMPLE) return "#9CA3AF";
  if (rate >= 97) return "#3B6D11";
  if (rate >= 85) return "#B5701A";
  return "#A32D2D";
}
function pct(rate: number | null, total?: number): string {
  if (rate === null) return "—";
  if (total !== undefined && total < MIN_SAMPLE) return `${rate}%*`;
  return `${rate}%`;
}
/** Seconds → "8.4s" / "2m 05s". Long scans read badly as raw seconds. */
function secs(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v < 60) return `${v.toFixed(1)}s`;
  const m = Math.floor(v / 60);
  return `${m}m ${String(Math.round(v - m * 60)).padStart(2, "0")}s`;
}

/**
 * "59 docs" / "92 lines" — the unit ships with every bucket from
 * /api/ocr-accuracy, so a parent and its children can never silently disagree
 * about what they counted. Singular where it reads better.
 */
function countWithUnit(total: number, unit: Bucket["unit"]): string {
  const noun =
    unit === "lines"
      ? total === 1 ? "line" : "lines"
      : total === 1 ? "doc" : "docs";
  return `${total} ${noun}`;
}

function Tile({ label, rate, sub, total }: { label: string; rate: number | null; sub: string; total?: number }) {
  return (
    <div className="rounded-lg bg-[#F5F1EA] px-4 py-3">
      <div className="text-xs text-[#8A8577] mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums" style={{ color: rateColor(rate, total) }}>{pct(rate, total)}</div>
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
        <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{countWithUnit(b.total, b.unit)}</td>
        <td className="px-2 py-2 text-right tabular-nums font-semibold" style={{ color: rateColor(b.rate, b.total) }}>{pct(b.rate, b.total)}</td>
        <td className="px-3 py-2 text-[#8A8577] text-xs">{b.topFails.length ? b.topFails.join(" · ") : "—"}</td>
      </tr>
      {open && hasKids
        ? b.children!.map((cc) => (
            <tr key={cc.key} className="border-t border-[#F6F2EA]">
              <td className="py-1.5 pl-9 pr-3 text-[#5F5E5A]">{cc.key}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-[#9A9384]">{countWithUnit(cc.total, cc.unit)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: rateColor(cc.rate, cc.total) }}>{pct(cc.rate, cc.total)}</td>
              <td className="px-3 py-1.5 text-[#9A9384] text-xs">{cc.topFails.length ? cc.topFails.join(" · ") : "—"}</td>
            </tr>
          ))
        : null}
    </>
  );
}

// Follows the Command Center's existing `period` dropdown (owner 2026-07-04):
// pick a month there → OCR recomputes for that month; "All-time" = no filter.
// The backend already accepts ?from=&to= (routes/ocr-accuracy.ts) so this is
// pure wiring — no new control on the card.
export function OcrAccuracyCard({
  period = "all",
  range = null,
}: {
  period?: string;
  range?: { from: string; to: string } | null;
}) {
  const qs = range ? `?from=${range.from}&to=${range.to}` : "";
  const { data, loading, failure, refresh } = useCachedJson<Resp>(
    `/api/ocr-accuracy${qs}`,
  );
  const d = data?.data;
  const periodLabel = period === "all" ? "All-time" : period;
  // "No scans yet." is a STATEMENT ABOUT THE BUSINESS — it tells the owner the
  // scanner has never been used this period. A killed request produced exactly
  // that sentence, because `d` is undefined for a 30 s abort and for a genuine
  // empty answer alike (C15 / BUG-2026-08-13-016, same shape one card down).
  // Only a 2xx body licenses the empty caption.
  const loadFailed = !d && failure != null && isUnknownOutcome(failure);

  return (
    <Card className="bg-white rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
          <div className="flex items-center gap-2">
            <ScanLine className="h-4.5 w-4.5 text-[#6B5C32]" />
            <span className="text-base font-semibold text-[#1F1D1B]">OCR Accuracy</span>
            <span className="text-xs font-normal text-[#9A9384]">· {periodLabel}</span>
          </div>
          <span className="text-xs text-[#8A8577]">Changed after upload = Fail · automate only near ~100% · * = fewer than 5 documents, not enough to judge</span>
        </div>

        {loading && !d ? (
          <div className="py-10 text-center text-sm text-[#9CA3AF]">Loading…</div>
        ) : loadFailed ? (
          <div className="py-10 text-center text-sm">
            <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-[#C2410C]" />
            <p className="font-semibold text-[#1F1D1B]">
              OCR accuracy couldn&apos;t be loaded
            </p>
            <p className="mt-1 text-[#4B5563]">{failure?.message}</p>
            <p className="mt-1 text-xs text-[#6B7280]">
              This is not a statement that nothing was scanned — the data never
              arrived.
            </p>
            <button
              type="button"
              onClick={refresh}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-xs font-semibold text-[#5A5550] hover:bg-[#F5F2ED]"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : !d || d.overall.total === 0 ? (
          <div className="py-10 text-center text-sm text-[#9CA3AF]">
            No scans yet. Once you scan and import orders / supplier docs, the accuracy shows here automatically.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-5">
              <Tile label="Overall" rate={d.overall.rate} total={d.overall.total} sub={`${d.overall.success} / ${d.overall.total} documents clean`} />
              <Tile label="Sales Orders" rate={d.salesOrders.rate} total={d.salesOrders.total} sub={countWithUnit(d.salesOrders.total, d.salesOrders.unit)} />
              <Tile label="Supplier (PO/PI/GRN)" rate={d.supplier.rate} total={d.supplier.total} sub={countWithUnit(d.supplier.total, d.supplier.unit)} />
            </div>

            {d.salesOrders.customers.length > 0 ? (
              <div className="mb-5">
                <div className="text-sm font-semibold text-[#6B5C32] mb-2">Sales Orders · Customer × Category <span className="font-normal text-[11px] text-[#9A9384]">(click a customer to expand categories — a customer row counts documents, a category row counts the lines on them, so the two do not add up)</span></div>
                <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#FAF7F2] text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <th className="px-3 py-2 text-left">Customer / Category</th>
                        <th className="px-2 py-2 text-right">Documents / Lines</th>
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

            {d.supplier.docTypes && d.supplier.docTypes.length > 0 ? (
              <div className="mb-5">
                <div className="text-sm font-semibold text-[#6B5C32] mb-2">
                  Supplier · by Document Type{" "}
                  <span className="font-normal text-[11px] text-[#9A9384]">
                    (Purchase Invoice vs Goods Received — from the doc type the AI read)
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#FAF7F2] text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <th className="px-3 py-2 text-left">Document type</th>
                        <th className="px-2 py-2 text-right">Documents</th>
                        <th className="px-2 py-2 text-right">Success</th>
                        <th className="px-3 py-2 text-left">Most-changed fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.supplier.docTypes.map((t) => (
                        <tr key={t.key} className="border-t border-[#F0ECE3]">
                          <td className="px-3 py-2 font-medium text-[#1F1D1B]">{t.key}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{countWithUnit(t.total, t.unit)}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-semibold" style={{ color: rateColor(t.rate, t.total) }}>{pct(t.rate, t.total)}</td>
                          <td className="px-3 py-2 text-[#8A8577] text-xs">{t.topFails.length ? t.topFails.join(" · ") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {d.timing && d.timing.buckets.length > 0 ? (
              <div className="mb-5">
                <div className="text-sm font-semibold text-[#6B5C32] mb-2">
                  Scan time{" "}
                  <span className="font-normal text-[11px] text-[#9A9384]">
                    (upload → result, {d.timing.totalScans} scans; repeat uploads served from cache are excluded)
                  </span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-[#E7E0D4]">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-[#FAF7F2] text-[11px] uppercase tracking-wide text-[#8A8577]">
                        <th className="px-3 py-2 text-left">Document type</th>
                        <th className="px-2 py-2 text-right">Scans</th>
                        <th className="px-2 py-2 text-right">Average</th>
                        <th className="px-2 py-2 text-right">Slowest 10%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.timing.buckets.map((t) => (
                        <tr key={t.key} className="border-t border-[#F0ECE3]">
                          <td className="px-3 py-2 font-medium text-[#1F1D1B]">{t.key}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{t.scans}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-semibold text-[#1F1D1B]">{secs(t.avgSec)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{secs(t.p90Sec)}</td>
                        </tr>
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
                        <th className="px-2 py-2 text-right">Documents</th>
                        <th className="px-2 py-2 text-right">Success</th>
                        <th className="px-3 py-2 text-left">Most-changed fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.supplier.suppliers.slice(0, 12).map((s) => (
                        <tr key={s.key} className="border-t border-[#F0ECE3]">
                          <td className="px-3 py-2 font-medium text-[#1F1D1B]">{s.key}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#6B7280]">{countWithUnit(s.total, s.unit)}</td>
                          {/* `s.total` must be passed: MIN_SAMPLE was added
                              BECAUSE this very panel printed a red 0% off ONE
                              document (owner 2026-08-05), and this row was the
                              one call site that never forwarded the sample
                              size — so the guard was live everywhere except
                              where it was asked for. */}
                          <td className="px-2 py-2 text-right tabular-nums font-semibold" style={{ color: rateColor(s.rate, s.total) }}>{pct(s.rate, s.total)}</td>
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
