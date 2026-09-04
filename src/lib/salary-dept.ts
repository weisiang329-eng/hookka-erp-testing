// ---------------------------------------------------------------------------
// Department-dimension salary maths, shared by the dashboard endpoint and the
// Forecast page. The department dimension exists ONLY in payslips — never in
// the GL — so both consumers aggregate the same raw rows with this one rule.
// Cost = gross pay + employer EPF/SOCSO/EIS (identical to aggregateLabour on
// the Labour tab, so the card's Σdepartments always equals that tab's total).
// ---------------------------------------------------------------------------

export type PayslipDeptRow = {
  period?: string | null;
  departmentCode?: string | null;
  department_code?: string | null;
  grossPaySen?: number | null; gross_pay_sen?: number | null;
  epfEmployerSen?: number | null; epf_employer_sen?: number | null;
  socsoEmployerSen?: number | null; socso_employer_sen?: number | null;
  eisEmployerSen?: number | null; eis_employer_sen?: number | null;
};

export type DeptCost = { dept: string; costSen: number };

export function groupPayslipsByMonthDept(rows: PayslipDeptRow[]): Map<string, DeptCost[]> {
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const ym = String(r.period ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    const dept = String(r.departmentCode ?? r.department_code ?? "").trim() || "(unassigned)";
    const cost =
      (Number(r.grossPaySen ?? r.gross_pay_sen) || 0) +
      (Number(r.epfEmployerSen ?? r.epf_employer_sen) || 0) +
      (Number(r.socsoEmployerSen ?? r.socso_employer_sen) || 0) +
      (Number(r.eisEmployerSen ?? r.eis_employer_sen) || 0);
    const m = byMonth.get(ym) ?? new Map<string, number>();
    m.set(dept, (m.get(dept) ?? 0) + cost);
    byMonth.set(ym, m);
  }
  const out = new Map<string, DeptCost[]>();
  for (const [ym, m] of byMonth) {
    out.set(
      ym,
      [...m.entries()].map(([dept, costSen]) => ({ dept, costSen })).sort((a, b) => a.dept.localeCompare(b.dept)),
    );
  }
  return out;
}

// --- Forecast supersede rule ------------------------------------------------
// A month that carries ANY `dept:` entry forecasts labour AT DEPARTMENT LEVEL;
// its DIRECT_LABOUR account entries (750-x) are display-only leftovers and
// MUST be ignored by every consumer, or the month double-counts. Keyed off the
// 750- prefix so this lib stays dependency-free: every DIRECT_LABOUR account
// in this COA is 750-x, and pnl-bucket.ts maps 750 → DIRECT_LABOUR by the
// same prefix.
const LABOUR_ACCOUNT_RE = /^750-/;

export function forecastEntryKind(code: string): "dept" | "labourAccount" | "other" {
  if (code.startsWith("dept:")) return "dept";
  if (LABOUR_ACCOUNT_RE.test(code)) return "labourAccount";
  return "other";
}

export function monthHasDeptForecast(pct: Record<string, unknown> | undefined | null): boolean {
  for (const k of Object.keys(pct ?? {})) if (k.startsWith("dept:")) return true;
  return false;
}

// Every account the labour map can post wages to (dept accounts + fallback +
// the three statutory accounts). A month that forecasts BY DEPARTMENT
// supersedes exactly these accounts — keying both a dept row and one of these
// would double-count, so both the Forecast page and the dashboard skip them
// in dept mode (owner 2026-08-24: dept rows follow the labour map's section).
export type LabourMapLike = {
  fallback?: string | null;
  byDept?: Record<string, string> | null;
  epf?: string | null;
  socso?: string | null;
  eis?: string | null;
};

export function labourMappedAccounts(map: LabourMapLike): string[] {
  const s = new Set<string>();
  const add = (v?: string | null) => {
    const t = String(v ?? "").trim();
    if (t) s.add(t);
  };
  add(map.fallback);
  add(map.epf);
  add(map.socso);
  add(map.eis);
  for (const v of Object.values(map.byDept ?? {})) add(v);
  return [...s].sort();
}
