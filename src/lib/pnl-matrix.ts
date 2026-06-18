// ---------------------------------------------------------------------------
// pnl-matrix.ts — pure builder for the Monthly P&L tab. Takes N PnlWindow
// columns (Accumulated + each FY month, computed by computePnlWindow) and
// emits the full P&L hierarchy as multi-column rows (values[] per column +
// pctValues[] = % of that column's net sales). Mirrors buildPnlRows' layout;
// uses the FIRST column (Accumulated = FY superset) as the row spine, each
// other column looked up by code (0 if absent). Read-only; all sen.
// ---------------------------------------------------------------------------

export interface PnlLine { code: string; name: string; amountSen: number }
export interface PnlRmGroup { group: string; description: string; openingSen: number; purchasesSen: number; closingSen: number }
export interface PnlExpenseLine { code: string; name: string; amountSen: number; salary: boolean }

export interface PnlWindowLike {
  netSalesSen: number;
  revLines: PnlLine[];
  rmGroups: PnlRmGroup[];
  rmConsumedSen: number;
  carriageSen: number;
  sstSen: number;
  labourLines: PnlLine[];
  labourSen: number;
  overheadLines: PnlLine[];
  overheadSen: number;
  wipOpen: number; wipClose: number; fgOpen: number; fgClose: number;
  manufacturingSen: number;
  cogsSen: number;
  grossProfitSen: number;
  otherIncomeSen: number;
  otherIncomeLines: PnlLine[];
  expenseLines: PnlExpenseLine[];
  expenseSen: number;
  netProfitSen: number;
}

export interface PnlMatrixCol { key: string; label: string; accum: boolean; window: PnlWindowLike }
export interface PnlMatrixRow {
  kind: "group" | "line" | "total" | "grandtotal" | "gap";
  depth: number;
  label: string;
  groupId?: string;
  accountCode?: string;
  values: number[];
  pctValues: number[];
}
export interface PnlMatrix { columns: { key: string; label: string; accum: boolean }[]; rows: PnlMatrixRow[] }

export function buildPnlMatrix(cols: PnlMatrixCol[]): PnlMatrix {
  const columns = cols.map((c) => ({ key: c.key, label: c.label, accum: c.accum }));
  const windows = cols.map((c) => c.window);
  const rows: PnlMatrixRow[] = [];
  const spine = windows[0];
  if (!spine) return { columns, rows };

  const netSales = windows.map((w) => w.netSalesSen);
  const pctOf = (vals: number[]) => vals.map((v, i) => (netSales[i] ? Math.round((v / netSales[i]) * 1000) / 10 : 0));
  const byCode = (list: { code: string; amountSen: number }[], code: string) => list.find((l) => l.code === code)?.amountSen ?? 0;

  let gid = 0;
  const push = (kind: PnlMatrixRow["kind"], depth: number, label: string, ex: (w: PnlWindowLike) => number, opts: { groupId?: string; accountCode?: string } = {}) => {
    const values = windows.map(ex);
    rows.push({ kind, depth, label, values, pctValues: pctOf(values), ...opts });
  };
  const group = (label: string, depth: number, ex: (w: PnlWindowLike) => number) => { const id = `g${gid++}`; push("group", depth, label, ex, { groupId: id }); return id; };
  const line = (label: string, depth: number, ex: (w: PnlWindowLike) => number, accountCode?: string) => push("line", depth, label, ex, { accountCode });
  const tot = (label: string, depth: number, ex: (w: PnlWindowLike) => number) => push("total", depth, label, ex);
  const grand = (label: string, ex: (w: PnlWindowLike) => number) => push("grandtotal", 0, label, ex);
  const gap = () => rows.push({ kind: "gap", depth: 0, label: "", values: [], pctValues: [] });

  // SALES
  group("SALES", 0, (w) => w.netSalesSen);
  for (const rl of spine.revLines) line(rl.name, 1, (w) => byCode(w.revLines, rl.code), rl.code);
  gap();

  // COST OF GOODS SOLD
  group("COST OF GOODS SOLD", 0, (w) => w.cogsSen);
  line("OPENING STOCK - FINISHED GOODS", 1, (w) => w.fgOpen);
  group("RAW MATERIALS", 1, (w) => w.rmConsumedSen);
  for (const rg of spine.rmGroups) {
    const find = (w: PnlWindowLike) => w.rmGroups.find((q) => q.group === rg.group);
    group(rg.description, 2, (w) => { const x = find(w); return x ? x.openingSen + x.purchasesSen - x.closingSen : 0; });
    line("OPENING STOCK", 3, (w) => find(w)?.openingSen ?? 0);
    line("PURCHASE", 3, (w) => find(w)?.purchasesSen ?? 0);
    line("CLOSING STOCK", 3, (w) => -(find(w)?.closingSen ?? 0));
  }
  line("CARRIAGE INWARDS", 1, (w) => w.carriageSen);
  line("SST CHARGES", 1, (w) => w.sstSen);
  group("DIRECT LABOUR", 1, (w) => w.labourSen);
  for (const ll of spine.labourLines) line(ll.name, 2, (w) => byCode(w.labourLines, ll.code), ll.code);
  group("FACTORY OVERHEAD", 1, (w) => w.overheadSen);
  for (const ol of spine.overheadLines) line(ol.name, 2, (w) => byCode(w.overheadLines, ol.code), ol.code);
  group("WORK IN PROGRESS", 1, (w) => w.wipOpen - w.wipClose);
  line("WIP - OPENING", 2, (w) => w.wipOpen);
  line("WIP - CLOSING", 2, (w) => -w.wipClose);
  tot("MANUFACTURING COST", 1, (w) => w.manufacturingSen);
  line("CLOSING STOCK - FINISHED GOODS", 1, (w) => -w.fgClose);
  grand("GROSS PROFIT / (LOSS)", (w) => w.grossProfitSen);
  gap();

  // OTHER INCOME
  if (spine.otherIncomeLines.length > 0 || windows.some((w) => w.otherIncomeSen !== 0)) {
    group("OTHER INCOME", 0, (w) => w.otherIncomeSen);
    for (const ol of spine.otherIncomeLines) line(ol.name, 1, (w) => byCode(w.otherIncomeLines, ol.code), ol.code);
  }

  // OPERATING EXPENSES
  group("OPERATING EXPENSES", 0, (w) => w.expenseSen);
  const salLines = spine.expenseLines.filter((l) => l.salary);
  if (salLines.length > 0) {
    group("SALARIES & CONTRIBUTION", 1, (w) => w.expenseLines.filter((l) => l.salary).reduce((s, l) => s + l.amountSen, 0));
    for (const sl of salLines) line(sl.name, 2, (w) => byCode(w.expenseLines, sl.code), sl.code);
  }
  for (const el of spine.expenseLines.filter((l) => !l.salary)) line(el.name, 1, (w) => byCode(w.expenseLines, el.code), el.code);
  grand("NET PROFIT / (LOSS)", (w) => w.netProfitSen);

  return { columns, rows };
}
