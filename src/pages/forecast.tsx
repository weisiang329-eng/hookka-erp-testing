// ---------------------------------------------------------------------------
// Forecast P&L (owner 2026-07-29) — a pure PLANNING page, zero contact with
// the books. The owner adds months himself ("有填才显示"), keys each month's
// projected SALES, and maintains every P&L line as a % of sales. Amounts are
// computed live (sales × %), a new month inherits the previous month's
// percentages, and the whole grid saves to kv `forecast_pnl`.
//
// Line structure mirrors the Monthly P&L: raw-material purchase accounts +
// carriage + SST + direct labour + factory overhead (→ COGS), other income,
// operating expenses — classified with the SAME pnl-bucket rules (incl. the
// owner's section-map overrides) so the forecast rows match the real report.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { TrendingUp, Plus, X, Save, Eye, EyeOff, ChevronDown, ChevronRight } from "lucide-react";
import { pnlBucketFor } from "@/lib/pnl-bucket";

type CoaAcct = { code: string; name: string; type: string; isPostable?: boolean };
// Per line-month the owner keys ONE of the two (owner 2026-07-29): a % of
// sales ("15.4") OR a direct RM amount ("3000") — typing one clears the
// other; the empty box shows the derived value as a grey placeholder.
type CellEntry = { p?: string; a?: string };
type MonthState = { salesStr: string; pct: Record<string, CellEntry> };

const CARRIAGE = "700-1015";
const SST = "706-0000";

const fmtRM = (sen: number) =>
  sen === 0 ? "-" : (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "15.4" → 1540 basis points (int); blank/garbage → 0.
const strToBp = (s: string): number => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
};
const bpToStr = (bp: number): string => (bp === 0 ? "" : (bp / 100).toString());

export default function ForecastPage() {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<CoaAcct[]>([]);
  const [override, setOverride] = useState<Record<string, string>>({});
  const [months, setMonths] = useState<Record<string, MonthState>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newYm, setNewYm] = useState("");
  // Owner 2026-07-29: parent sections collapse, and lines with no figure in
  // ANY month hide once saved data exists (toggle reveals them for keying —
  // a line stays visible the moment it carries a number, and totals always
  // sum EVERY line, hidden or not).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showEmpty, setShowEmpty] = useState(true);

  useEffect(() => {
    let stale = false;
    type Wrapped = { success?: boolean; data?: unknown };
    Promise.all([
      fetch("/api/accounting/coa").then((r) => r.json() as Promise<Wrapped>),
      fetch("/api/accounting/pnl/section-map").then((r) => r.json() as Promise<Wrapped>),
      fetch("/api/accounting/forecast").then((r) => r.json() as Promise<Wrapped>),
    ])
      .then(([coaJ, mapJ, fcJ]) => {
        if (stale) return;
        const coa = (coaJ?.data ?? coaJ ?? []) as CoaAcct[];
        setAccounts(Array.isArray(coa) ? coa : []);
        setOverride(((mapJ?.data as { map?: Record<string, string> } | undefined)?.map ?? {}) as Record<string, string>);
        const saved = ((fcJ?.data as { months?: Record<string, { salesSen?: number; pct?: Record<string, number | { bp?: number; amtSen?: number }> }> } | undefined)?.months ?? {});
        const next: Record<string, MonthState> = {};
        for (const [ym, m] of Object.entries(saved)) {
          const pct: Record<string, CellEntry> = {};
          for (const [code, v] of Object.entries(m.pct ?? {})) {
            // Legacy shape = bare bp number; new shape = { bp } or { amtSen }.
            if (typeof v === "number") pct[code] = { p: bpToStr(v) };
            else if (v && typeof v === "object") {
              const o = v as { bp?: number; amtSen?: number };
              if (o.amtSen) pct[code] = { a: (Number(o.amtSen) / 100).toString() };
              else if (o.bp) pct[code] = { p: bpToStr(Number(o.bp) || 0) };
            }
          }
          next[ym] = { salesStr: m.salesSen ? (Number(m.salesSen) / 100).toFixed(2) : "", pct };
        }
        setMonths(next);
        // Saved figures exist → start with empty lines hidden (owner rule);
        // a fresh page shows everything so the first month can be keyed.
        setShowEmpty(!Object.values(next).some((mm) => Object.keys(mm.pct).length > 0));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      stale = true;
    };
  }, []);

  // ---- Line structure (same classification as the real P&L) ----
  const lines = useMemo(() => {
    const postable = accounts.filter((a) => a.isPostable !== false);
    const materialAccts = postable
      .filter(
        (a) =>
          a.type === "COST" &&
          pnlBucketFor(a.code, a.type, override) === null &&
          a.code !== CARRIAGE &&
          a.code !== SST &&
          !/STOCK|PROGRESS/i.test(a.name),
      )
      .sort((a, b) => a.code.localeCompare(b.code));
    // Owner 2026-07-29: materials forecast by TYPE, not by sofa/bedframe —
    // "PURCHASE - B.M FABRIC" / "S FABRIC" / "S.M FABRIC" fold into ONE
    // FABRIC row (likewise FILLER / WEBBING / …). Percentages store under a
    // stable `cat:<TYPE>` key, so a future sofa/bedframe split can add
    // per-line rows without clashing with what was keyed here.
    const catOf = (name: string): string => {
      const stripped = name.replace(/^PURCHASE\s*-\s*/i, "").trim();
      const cat = stripped.replace(/^(B\.M|S\.M|B|S)[.\s]+/i, "").trim();
      return cat || stripped;
    };
    const catNames = [...new Set(materialAccts.map((a) => catOf(a.name)))].sort();
    const materials = catNames.map(
      (n) => ({ code: `cat:${n}`, name: n, type: "COST" }) as CoaAcct,
    );
    const byBucket = (bucket: string) =>
      postable
        .filter((a) => pnlBucketFor(a.code, a.type, override) === bucket)
        .sort((a, b) => a.code.localeCompare(b.code));
    const direct = postable.filter((a) => a.code === CARRIAGE || a.code === SST);
    return {
      materials,
      direct,
      labour: byBucket("DIRECT_LABOUR"),
      overhead: byBucket("FACTORY_OVERHEAD"),
      otherIncome: byBucket("OTHER_INCOME"),
      expenses: [...byBucket("OPEX_SALARIES"), ...byBucket("OPERATING_EXPENSE")].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    };
  }, [accounts, override]);
  const cogsRows = useMemo(
    () => [...lines.materials, ...lines.direct, ...lines.labour, ...lines.overhead],
    [lines],
  );

  const yms = useMemo(() => Object.keys(months).sort(), [months]);

  // ---- Per-month computed figures ----
  const calc = (ym: string) => {
    const m = months[ym];
    const salesSen = Math.max(0, Math.round((parseFloat(m?.salesStr ?? "") || 0) * 100));
    // Amount-keyed cells win; %-keyed cells derive from sales.
    const amt = (code: string) => {
      const e = m?.pct[code];
      if (e?.a !== undefined && e.a !== "") return Math.round((parseFloat(e.a) || 0) * 100);
      return Math.round((salesSen * strToBp(e?.p ?? "")) / 10000);
    };
    const sum = (rows: CoaAcct[]) => rows.reduce((s, r) => s + amt(r.code), 0);
    const cogs = sum(cogsRows);
    const oi = sum(lines.otherIncome);
    const exp = sum(lines.expenses);
    const gp = salesSen - cogs;
    return { salesSen, amt, cogs, gp, oi, exp, np: gp + oi - exp };
  };

  // Keying one side CLEARS the other (owner: "就是其中一个").
  const setPctStr = (ym: string, code: string, v: string) =>
    setMonths((prev) => ({ ...prev, [ym]: { ...prev[ym], pct: { ...prev[ym].pct, [code]: v === "" ? {} : { p: v } } } }));
  const setAmtStr = (ym: string, code: string, v: string) =>
    setMonths((prev) => ({ ...prev, [ym]: { ...prev[ym], pct: { ...prev[ym].pct, [code]: v === "" ? {} : { a: v } } } }));
  const setSales = (ym: string, v: string) =>
    setMonths((prev) => ({ ...prev, [ym]: { ...prev[ym], salesStr: v } }));

  const addMonth = () => {
    const ym = newYm;
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      toast.error("Pick a month first");
      return;
    }
    if (months[ym]) {
      toast.error(`${ym} already exists`);
      return;
    }
    // A new month inherits the PREVIOUS month's percentages (owner rule);
    // the very first month starts blank — the owner keys every % himself.
    const prevYm = [...yms].filter((k) => k < ym).pop() ?? [...yms].pop();
    const inherited = prevYm ? { ...months[prevYm].pct } : {};
    setMonths((prev) => ({ ...prev, [ym]: { salesStr: "", pct: inherited } }));
    setNewYm("");
  };

  const removeMonth = (ym: string) =>
    setMonths((prev) => {
      const next = { ...prev };
      delete next[ym];
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, { salesSen: number; pct: Record<string, { bp?: number; amtSen?: number }> }> = {};
      for (const [ym, m] of Object.entries(months)) {
        const pct: Record<string, { bp?: number; amtSen?: number }> = {};
        for (const [code, e] of Object.entries(m.pct)) {
          if (e.a !== undefined && e.a !== "") {
            const sen = Math.round((parseFloat(e.a) || 0) * 100);
            if (sen !== 0) pct[code] = { amtSen: sen };
          } else if (e.p !== undefined && e.p !== "") {
            const bp = strToBp(e.p);
            if (bp !== 0) pct[code] = { bp };
          }
        }
        payload[ym] = { salesSen: Math.max(0, Math.round((parseFloat(m.salesStr) || 0) * 100)), pct };
      }
      const res = await fetch("/api/accounting/forecast", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: payload }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && j?.success) toast.success("Forecast saved");
      else toast.error(j?.error || "Couldn't save the forecast — please try again.");
    } catch {
      toast.error("Couldn't save the forecast — connection hiccup, please try again.");
    }
    setSaving(false);
  };

  // ---- Render helpers ----
  // One cell = [ % ] + [ RM ] — key EITHER; the empty box shows the derived
  // value as a grey placeholder (10% of 50,000 → RM box hints 5,000.00; keyed
  // RM 3,000 on 50,000 sales → % box hints 6).
  const cellInputs = (ym: string, code: string) => {
    const e = months[ym]?.pct[code] ?? {};
    const c = calc(ym);
    const amtKeyed = e.a !== undefined && e.a !== "";
    const pctKeyed = e.p !== undefined && e.p !== "";
    const derivedPct =
      amtKeyed && c.salesSen > 0
        ? ((Math.round((parseFloat(e.a as string) || 0) * 100) / c.salesSen) * 100).toFixed(1)
        : "";
    const derivedAmt = pctKeyed ? (c.amt(code) / 100).toFixed(2) : "";
    return (
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex items-center rounded border border-[#E2DDD8] bg-white px-1">
          <input
            type="number"
            step="0.1"
            value={e.p ?? ""}
            onChange={(ev) => setPctStr(ym, code, ev.target.value)}
            placeholder={derivedPct || "-"}
            className="w-12 py-0.5 text-right text-[12px] tabular-nums outline-none placeholder:text-[#C7C1BA]"
          />
          <span className="text-[10px] text-[#9CA3AF] ml-0.5">%</span>
        </span>
        <span className="inline-flex items-center rounded border border-[#E2DDD8] bg-white px-1">
          <span className="text-[10px] text-[#9CA3AF] mr-0.5">RM</span>
          <input
            type="number"
            step="0.01"
            value={e.a ?? ""}
            onChange={(ev) => setAmtStr(ym, code, ev.target.value)}
            placeholder={derivedAmt || "-"}
            className="w-20 py-0.5 text-right text-[12px] tabular-nums outline-none placeholder:text-[#C7C1BA]"
          />
        </span>
      </span>
    );
  };
  const acctRow = (a: CoaAcct, indent = true) => (
    <tr key={a.code} className="border-b border-[#F0ECE9]">
      <td className={`px-3 py-1 sticky left-0 bg-white whitespace-nowrap ${indent ? "pl-7" : ""}`}>
        {!a.code.startsWith("cat:") && (
          <span className="tabular-nums text-[11px] text-[#9CA3AF] mr-1.5">{a.code}</span>
        )}
        <span className="text-[#1F1D1B]">{a.name}</span>
      </td>
      {yms.map((ym) => (
        <td key={ym} className="px-2 py-1 text-right whitespace-nowrap border-l border-[#F0ECE9]">
          {cellInputs(ym, a.code)}
        </td>
      ))}
    </tr>
  );
  // A line "has a figure" when any month carries a keyed % or RM.
  const rowHasData = (code: string) =>
    yms.some((ym) => {
      const e = months[ym]?.pct[code];
      return !!e && ((e.p !== undefined && e.p !== "") || (e.a !== undefined && e.a !== ""));
    });
  // Parent section row: collapse toggle + per-month section totals.
  const section = (key: string, title: string, rows: CoaAcct[]) => {
    if (rows.length === 0) return null;
    const open = !collapsed[key];
    const visible = showEmpty ? rows : rows.filter((r) => rowHasData(r.code));
    return (
      <>
        <tr key={`sec-${key}`} className="bg-[#F7F4EF] border-b border-[#E2DDD8]">
          <td className="px-3 py-1.5 sticky left-0 bg-[#F7F4EF] whitespace-nowrap">
            <button
              onClick={() => setCollapsed((p) => ({ ...p, [key]: open }))}
              className="text-[11px] font-semibold text-[#6B5C32] cursor-pointer inline-flex items-center gap-1"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {title}
              {!showEmpty && visible.length < rows.length && (
                <span className="font-normal text-[#9CA3AF]">({rows.length - visible.length} empty hidden)</span>
              )}
            </button>
          </td>
          {yms.map((ym) => {
            const c = calc(ym);
            const tot = rows.reduce((s, r) => s + c.amt(r.code), 0);
            return (
              <td key={ym} className="px-2 py-1.5 text-right tabular-nums font-semibold text-[#6B5C32] border-l border-[#F0ECE9]">
                {fmtRM(tot)}
              </td>
            );
          })}
        </tr>
        {open && visible.map((a) => acctRow(a))}
      </>
    );
  };
  const totalRow = (label: string, val: (c: ReturnType<typeof calc>) => number, strong = false) => (
    <tr className={`border-b border-[#E2DDD8] ${strong ? "bg-[#EAF3DE] font-bold" : "bg-[#F0ECE9]/60 font-semibold"}`}>
      <td className="px-3 py-1.5 sticky left-0 whitespace-nowrap" style={{ background: strong ? "#EAF3DE" : "#F5F2EE" }}>
        {label}
      </td>
      {yms.map((ym) => {
        const v = val(calc(ym));
        return (
          <td key={ym} className={`px-2 py-1.5 text-right tabular-nums border-l border-[#F0ECE9] ${v < 0 ? "text-[#9A3A2D]" : ""}`}>
            {fmtRM(v)}
          </td>
        );
      })}
    </tr>
  );

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-[#1F1D1B] flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-[#6B5C32]" /> Forecast P&L
        </h2>
        <span className="text-xs text-[#9CA3AF]">
          Planning only — nothing here touches the books. Key SALES per month; every line = % of sales; a new month
          inherits the previous month's percentages.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="month"
            value={newYm}
            onChange={(e) => setNewYm(e.target.value)}
            className="rounded-md border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
          />
          <Button variant="outline" size="sm" onClick={addMonth}>
            <Plus className="h-4 w-4 mr-1" /> Add month
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowEmpty((v) => !v)} title="Lines without a figure hide once saved — toggle to key new ones">
            {showEmpty ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
            {showEmpty ? "Hide empty lines" : "Show empty lines"}
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !loaded}>
            <Save className="h-4 w-4 mr-1" /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {!loaded ? (
        <Card>
          <CardContent className="py-12 text-center text-[#6B7280] text-sm">Loading…</CardContent>
        </Card>
      ) : yms.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-[#6B7280] text-sm">
            No forecast months yet — pick a month above and press <strong>Add month</strong> to start.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="text-[13px] whitespace-nowrap w-full">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-[11px] text-[#6B7280]">
                  <th className="px-3 py-2 text-left sticky left-0 bg-white">LINE</th>
                  {yms.map((ym) => (
                    <th key={ym} className="px-2 py-2 text-right border-l border-[#E2DDD8]">
                      <span className="font-semibold text-[#1F1D1B]">{ym}</span>
                      <button
                        onClick={() => removeMonth(ym)}
                        title="Remove this month (takes effect on Save)"
                        className="ml-2 text-[#9A3A2D] hover:text-[#791F1F] cursor-pointer"
                      >
                        <X className="h-3 w-3 inline" />
                      </button>
                      <div className="text-[10px] font-normal text-[#9CA3AF]">% · RM</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[#E2DDD8] bg-[#F6F1E7]">
                  <td className="px-3 py-1.5 sticky left-0 bg-[#F6F1E7] font-semibold">SALES (keyed)</td>
                  {yms.map((ym) => (
                    <td key={ym} className="px-2 py-1.5 text-right border-l border-[#F0ECE9]">
                      <input
                        type="number"
                        step="0.01"
                        value={months[ym]?.salesStr ?? ""}
                        onChange={(e) => setSales(ym, e.target.value)}
                        placeholder="0.00"
                        className="w-32 rounded border border-[#E2DDD8] px-2 py-0.5 text-right tabular-nums"
                      />
                    </td>
                  ))}
                </tr>
                {section("mat", "RAW MATERIALS / PURCHASES", [...lines.materials, ...lines.direct])}
                {section("lab", "DIRECT LABOUR", lines.labour)}
                {section("ovh", "FACTORY OVERHEAD", lines.overhead)}
                {totalRow("TOTAL COGS", (c) => c.cogs)}
                {totalRow("GROSS PROFIT", (c) => c.gp, true)}
                {section("oi", "OTHER INCOME", lines.otherIncome)}
                {section("exp", "OPERATING EXPENSES", lines.expenses)}
                {totalRow("TOTAL EXPENSES", (c) => c.exp)}
                {totalRow("NET PROFIT", (c) => c.np, true)}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
