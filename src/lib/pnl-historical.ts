// ---------------------------------------------------------------------------
// pnl-historical.ts — pure helpers for Task 3.1+3.2: historical P&L injection.
//
// These functions are in a separate lib so they can be tested without pulling
// in accounting.ts (which depends on Cloudflare Workers / Hono types).
//
// The stored window_json only needs to match PnlWindowLike (the shape consumed
// by buildPnlMatrix / buildPnlRows). materialWarnings is a runtime-only field
// from computePnlWindow and is NOT stored in pnl_historical.
// ---------------------------------------------------------------------------

import type { PnlWindowLike, PnlLine, PnlExpenseLine, PnlRmGroup } from "./pnl-matrix";

export type { PnlWindowLike };

// A stored historical window. Matches PnlWindowLike exactly.
export type HistoricalPnlWindow = PnlWindowLike;

export type PnlProductLine = "all" | "sofa" | "bedframe";

/**
 * Raw pnl_historical row shape as returned by the DB layer.
 *
 * The Postgres adapter (src/api/lib/db-pg.ts) camelCases every result column
 * via `transform.column.from`, so the `window_json` column arrives as
 * `windowJson`. Accept BOTH keys so the reader is robust to either casing
 * (repo rule: read rows dual-keyed `r.camelCase ?? r.snake_case`).
 */
export type HistoricalPnlRow = {
  ym: string;
  line: string;
  windowJson?: string | null;
  window_json?: string | null;
};

/**
 * Group raw pnl_historical rows into Map<ym, {all?,sofa?,bedframe?}>.
 *
 * Reads window_json dual-keyed (windowJson ?? window_json). The Postgres
 * adapter returns it camelCased as `windowJson`; reading only `window_json`
 * yields undefined → JSON.parse throws → every row is silently skipped → the
 * map comes back empty → no historical P&L is injected. That was the
 * 2026-06-30 prod bug (39 rows present, nothing displayed). Rows with an
 * unrecognised `line` or unparseable / missing JSON are skipped.
 */
export function buildHistoricalMap(
  rows: HistoricalPnlRow[],
): Map<string, Partial<Record<PnlProductLine, HistoricalPnlWindow>>> {
  const map = new Map<string, Partial<Record<PnlProductLine, HistoricalPnlWindow>>>();
  for (const row of rows) {
    const raw = row.windowJson ?? row.window_json;
    if (!raw) continue;
    let parsed: HistoricalPnlWindow;
    try {
      parsed = JSON.parse(raw) as HistoricalPnlWindow;
    } catch {
      continue;
    }
    const existing = map.get(row.ym) ?? {};
    if (row.line === "all" || row.line === "sofa" || row.line === "bedframe") {
      existing[row.line] = parsed;
    }
    map.set(row.ym, existing);
  }
  return map;
}

/**
 * Pure column-selection predicate.
 *
 * Returns the stored historical window if `ym` is strictly before
 * `openingMonth` AND an entry for the given `line` exists in `historical`.
 * Returns null otherwise — the caller should fall back to computePnlWindow.
 *
 * Exported so tests can verify the predicate without any DB.
 */
export function selectHistoricalWindow(
  historical: Map<string, Partial<Record<PnlProductLine, HistoricalPnlWindow>>>,
  openingMonth: string | null,
  ym: string,
  line: PnlProductLine,
): HistoricalPnlWindow | null {
  if (!openingMonth || ym >= openingMonth) return null;
  return historical.get(ym)?.[line] ?? null;
}

/**
 * Pure accumulator: sum an array of PnlWindowLike objects into one.
 * Sen fields are summed; line arrays are merged by `code` or `group`,
 * summing amounts. Safe to pass an empty array — returns an all-zero window.
 */
export function sumPnlWindows(windows: HistoricalPnlWindow[]): HistoricalPnlWindow {
  if (windows.length === 0) {
    return {
      netSalesSen: 0, revLines: [], rmGroups: [], rmConsumedSen: 0,
      carriageSen: 0, sstSen: 0, labourLines: [], labourSen: 0,
      overheadLines: [], overheadSen: 0, wipOpen: 0, wipClose: 0,
      fgOpen: 0, fgClose: 0, manufacturingSen: 0, cogsSen: 0,
      grossProfitSen: 0, otherIncomeSen: 0, otherIncomeLines: [],
      expenseLines: [], expenseSen: 0, netProfitSen: 0,
    };
  }

  // Historical windows keyed from the old books carry code:"" on every line
  // (names only — the old accounts were never mapped to system COA codes).
  // Merging strictly by `code` collapsed ALL of them into ONE row (labelled by
  // whichever line came first — "Bank Charges" on prod, RM 407,750.36 lump,
  // owner report 2026-07-02). Key by code, falling back to name.
  const lineKey = (item: { code: string; name?: string }): string =>
    item.code || item.name || "";

  function mergeByCode<T extends { code: string; name?: string; amountSen: number }>(arrays: T[][]): T[] {
    const map = new Map<string, T>();
    for (const arr of arrays) {
      for (const item of arr) {
        const existing = map.get(lineKey(item));
        if (!existing) {
          map.set(lineKey(item), { ...item });
        } else {
          existing.amountSen += item.amountSen;
        }
      }
    }
    return [...map.values()];
  }

  function mergeRmGroups(arrays: PnlRmGroup[][]): PnlRmGroup[] {
    const map = new Map<string, PnlRmGroup>();
    for (const arr of arrays) {
      for (const item of arr) {
        const existing = map.get(item.group);
        if (!existing) {
          map.set(item.group, { ...item });
        } else {
          existing.openingSen += item.openingSen;
          existing.purchasesSen += item.purchasesSen;
          existing.closingSen += item.closingSen;
        }
      }
    }
    return [...map.values()];
  }

  function mergeExpenseLines(arrays: PnlExpenseLine[][]): PnlExpenseLine[] {
    const map = new Map<string, PnlExpenseLine>();
    for (const arr of arrays) {
      for (const item of arr) {
        const existing = map.get(lineKey(item));
        if (!existing) {
          map.set(lineKey(item), { ...item });
        } else {
          existing.amountSen += item.amountSen;
        }
      }
    }
    return [...map.values()];
  }

  const sum = (key: keyof HistoricalPnlWindow): number =>
    windows.reduce((acc, w) => acc + ((w[key] as number) || 0), 0);

  return {
    netSalesSen: sum("netSalesSen"),
    revLines: mergeByCode(windows.map((w) => w.revLines) as PnlLine[][]),
    rmGroups: mergeRmGroups(windows.map((w) => w.rmGroups)),
    rmConsumedSen: sum("rmConsumedSen"),
    carriageSen: sum("carriageSen"),
    sstSen: sum("sstSen"),
    labourLines: mergeByCode(windows.map((w) => w.labourLines) as PnlLine[][]),
    labourSen: sum("labourSen"),
    overheadLines: mergeByCode(windows.map((w) => w.overheadLines) as PnlLine[][]),
    overheadSen: sum("overheadSen"),
    wipOpen: sum("wipOpen"),
    wipClose: sum("wipClose"),
    fgOpen: sum("fgOpen"),
    fgClose: sum("fgClose"),
    manufacturingSen: sum("manufacturingSen"),
    cogsSen: sum("cogsSen"),
    grossProfitSen: sum("grossProfitSen"),
    otherIncomeSen: sum("otherIncomeSen"),
    otherIncomeLines: mergeByCode(windows.map((w) => w.otherIncomeLines) as PnlLine[][]),
    expenseLines: mergeExpenseLines(windows.map((w) => w.expenseLines)),
    expenseSen: sum("expenseSen"),
    netProfitSen: sum("netProfitSen"),
  };
}
