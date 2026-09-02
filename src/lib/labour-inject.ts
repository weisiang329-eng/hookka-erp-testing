// labour-inject — which months of a P&L window get report-layer labour.
//
// Owner 2026-08-31: 「任何时候我看P&L 时你都自动提取…当当月我已经记录salary
// 了，你就以我记录的为准」. The P&L no longer waits for the Labour tab's Post:
// a month whose labour is NOT in the GL gets its payroll figures injected at
// report time (payslips if generated, else a dry run of the same engine).
//
// This module owns only the month arithmetic — WHICH months qualify:
//   · never before the opening month (earlier months come from the keyed
//     historical P&L, which already contains labour)
//   · never after the current month (no clairvoyance)
//   · never a month that already has ANY salary-accrual credit in the GL
//     (Labour tab post OR a manual JV — the owner posts office salaries by
//     JV; injecting on top would double-count). "Recorded wins."
//
// Pure and unit-tested; the DB-facing injection lives in routes/accounting.ts.

const nextYm = (ym: string): string => {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

export function labourInjectMonths(opts: {
  startYm: string | null;
  endYm: string | null;
  openingYm: string | null;
  nowYm: string;
  recordedYms: ReadonlySet<string>;
}): string[] {
  const { startYm, endYm, openingYm, nowYm, recordedYms } = opts;
  // No opening date → the books have no live start; nothing to inject.
  if (!openingYm) return [];
  let lo = startYm && startYm > openingYm ? startYm : openingYm;
  const hi = endYm && endYm < nowYm ? endYm : nowYm;
  const out: string[] = [];
  // 60-month hard stop — a malformed bound must not spin the loop.
  for (let i = 0; i < 60 && lo <= hi; i++, lo = nextYm(lo)) {
    if (!recordedYms.has(lo)) out.push(lo);
  }
  return out;
}
