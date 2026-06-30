#!/usr/bin/env node
/**
 * scripts/build-historical-windows.mjs
 *
 * Reads scripts/out/historical-pnl.json (13 months, 2025-04..2026-04) and
 * produces scripts/out/pnl-historical-insert.sql — 39 UPSERT rows for
 * pnl_historical (all 13 months × 3 lines: all / sofa / bedframe).
 *
 * Run: node scripts/build-historical-windows.mjs
 * Output: scripts/out/pnl-historical-insert.sql
 *
 * Design notes (from Task 3.3 brief):
 *   - Money is integer sen throughout; Math.round() for split windows.
 *   - Date is hardcoded to avoid non-deterministic Date.now().
 *   - revLines = two sales lines only (BEDFRAME + SOFA, drop if 0).
 *     netSalesSen = salesBedframeSen + salesSofaSen − returnInwardSen + discountAllowedSen
 *     (discountAllowedSen is negative in JSON; returnInwardSen is positive → subtract it).
 *     SALES group header in buildPnlMatrix renders netSalesSen directly; revLines are
 *     listed as informational sub-lines underneath — they do NOT need to sum to netSalesSen.
 *     So we keep revLines = raw sales lines (no DISC/RETURN adjustment lines needed).
 *   - sofa/bedframe windows are pro-rata by salesSofaSen / salesBedframeSen; when one
 *     product has zero sales the split window is all-zero / equals the `all` window.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const INPUT  = join(ROOT, "scripts", "out", "historical-pnl.json");
const OUTPUT = join(ROOT, "scripts", "out", "pnl-historical-insert.sql");
const ORG_ID = "hookka";
const UPDATED_AT = "2026-06-29T00:00:00.000Z";

/** Build the "all" PnlWindow from one historical-pnl month record. */
function buildAllWindow(m) {
  // Revenue
  const revLines = [];
  if (m.salesBedframeSen !== 0) {
    revLines.push({ code: "500-0000", name: "SALES - BEDFRAME", amountSen: m.salesBedframeSen });
  }
  if (m.salesSofaSen !== 0) {
    revLines.push({ code: "500-0020", name: "SALES - SOFA", amountSen: m.salesSofaSen });
  }
  // netSalesSen = gross sales − returnInward + discountAllowed
  // discountAllowedSen is already stored as negative in JSON; returnInwardSen is positive.
  const netSalesSen = m.salesBedframeSen + m.salesSofaSen - m.returnInwardSen + m.discountAllowedSen;

  // RM groups
  const rmGroups = m.rmCategories.map((cat) => ({
    group: cat.code,
    description: cat.name,
    openingSen: cat.openingSen,
    purchasesSen: cat.purchaseSen,
    closingSen: cat.closingSen,
  }));
  const rmConsumedSen = rmGroups.reduce(
    (sum, g) => sum + g.openingSen + g.purchasesSen - g.closingSen,
    0,
  );

  // Labour
  const labourLines = [{ code: "750", name: "DIRECT LABOUR", amountSen: m.labourSen }];
  const labourSen = m.labourSen;

  // Overhead
  const overheadLines = m.overheadLines.map((ol) => ({
    code: "780",
    name: ol.name,
    amountSen: ol.sen,
  }));
  const overheadSen = overheadLines.reduce((s, ol) => s + ol.amountSen, 0);

  // WIP / FG
  const wipOpen = m.wipOpenSen;
  const wipClose = m.wipCloseSen;
  const fgOpen = m.openingFGSen;
  const fgClose = m.closingFGSen;

  // Manufacturing = rmConsumed + carriage + sst + labour + overhead + (wipOpen - wipClose)
  const manufacturingSen =
    rmConsumedSen + m.carriageSen + m.sstSen + labourSen + overheadSen + (wipOpen - wipClose);

  // COGS = fgOpen + manufacturing - fgClose
  const cogsSen = fgOpen + manufacturingSen - fgClose;

  // Gross profit
  const grossProfitSen = netSalesSen - cogsSen;

  // Other income
  const otherIncomeSen = m.otherIncomeSen;
  const otherIncomeLines =
    otherIncomeSen !== 0
      ? [{ code: "OTHER", name: "OTHER INCOME", amountSen: otherIncomeSen }]
      : [];

  // Expenses — code "900" + name; salary flag for known salary lines
  const SALARY_NAMES = new Set([
    "Staff Salaries & Overtime",
    "E'yer SOCSO",
    "E'yerEPF",
    "E'yer EIS",
    "Staff's HRDF",
    "Part time worker/wages",
    "Staff Refershment",
  ]);
  const expenseLines = m.expenseLines
    .filter((el) => el.sen !== 0)
    .map((el) => ({
      code: "900",
      name: el.name,
      amountSen: el.sen,
      salary: SALARY_NAMES.has(el.name),
    }));
  const expenseSen = expenseLines.reduce((s, el) => s + el.amountSen, 0);

  // Net profit = grossProfit + otherIncome − expenses
  const netProfitSen = grossProfitSen + otherIncomeSen - expenseSen;

  return {
    netSalesSen,
    revLines,
    rmGroups,
    rmConsumedSen,
    carriageSen: m.carriageSen,
    sstSen: m.sstSen,
    labourLines,
    labourSen,
    overheadLines,
    overheadSen,
    wipOpen,
    wipClose,
    fgOpen,
    fgClose,
    manufacturingSen,
    cogsSen,
    grossProfitSen,
    otherIncomeSen,
    otherIncomeLines,
    expenseLines,
    expenseSen,
    netProfitSen,
  };
}

/** Scale an integer sen value by ratio R, rounding to nearest integer. */
function scale(sen, R) {
  return Math.round(sen * R);
}

/** Build the split (sofa or bedframe) PnlWindow from the `all` window. */
function buildSplitWindow(allW, m, productLine) {
  const totalSales = m.salesSofaSen + m.salesBedframeSen;

  // When there are no sales for this product line, return an all-zero window.
  const salesThisLine = productLine === "sofa" ? m.salesSofaSen : m.salesBedframeSen;
  if (totalSales === 0 || salesThisLine === 0) {
    return {
      netSalesSen: 0,
      revLines: [],
      rmGroups: allW.rmGroups.map((g) => ({
        ...g,
        openingSen: 0,
        purchasesSen: 0,
        closingSen: 0,
      })),
      rmConsumedSen: 0,
      carriageSen: 0,
      sstSen: 0,
      labourLines: allW.labourLines.map((ll) => ({ ...ll, amountSen: 0 })),
      labourSen: 0,
      overheadLines: allW.overheadLines.map((ol) => ({ ...ol, amountSen: 0 })),
      overheadSen: 0,
      wipOpen: 0,
      wipClose: 0,
      fgOpen: 0,
      fgClose: 0,
      manufacturingSen: 0,
      cogsSen: 0,
      grossProfitSen: 0,
      otherIncomeSen: 0,
      otherIncomeLines: [],
      expenseLines: allW.expenseLines.map((el) => ({ ...el, amountSen: 0 })),
      expenseSen: 0,
      netProfitSen: 0,
    };
  }

  const R = salesThisLine / totalSales;

  // Revenue: exact for this product line
  const salesCodeForLine = productLine === "sofa" ? "500-0020" : "500-0000";
  const salesNameForLine = productLine === "sofa" ? "SALES - SOFA" : "SALES - BEDFRAME";
  const revLines = salesThisLine !== 0
    ? [{ code: salesCodeForLine, name: salesNameForLine, amountSen: salesThisLine }]
    : [];

  // Split discount/return by R so netSalesSen ties
  const discountSplit = scale(m.discountAllowedSen, R);
  const returnSplit = scale(m.returnInwardSen, R);
  const netSalesSen = salesThisLine - returnSplit + discountSplit;

  // Scale RM groups
  const rmGroups = allW.rmGroups.map((g) => ({
    ...g,
    openingSen: scale(g.openingSen, R),
    purchasesSen: scale(g.purchasesSen, R),
    closingSen: scale(g.closingSen, R),
  }));
  const rmConsumedSen = rmGroups.reduce(
    (sum, g) => sum + g.openingSen + g.purchasesSen - g.closingSen,
    0,
  );

  const carriageSen = scale(allW.carriageSen, R);
  const sstSen = scale(allW.sstSen, R);

  const labourLines = allW.labourLines.map((ll) => ({
    ...ll,
    amountSen: scale(ll.amountSen, R),
  }));
  const labourSen = labourLines.reduce((s, ll) => s + ll.amountSen, 0);

  const overheadLines = allW.overheadLines.map((ol) => ({
    ...ol,
    amountSen: scale(ol.amountSen, R),
  }));
  const overheadSen = overheadLines.reduce((s, ol) => s + ol.amountSen, 0);

  const wipOpen = scale(allW.wipOpen, R);
  const wipClose = scale(allW.wipClose, R);
  const fgOpen = scale(allW.fgOpen, R);
  const fgClose = scale(allW.fgClose, R);

  const manufacturingSen =
    rmConsumedSen + carriageSen + sstSen + labourSen + overheadSen + (wipOpen - wipClose);
  const cogsSen = fgOpen + manufacturingSen - fgClose;
  const grossProfitSen = netSalesSen - cogsSen;

  const otherIncomeSen = scale(allW.otherIncomeSen, R);
  const otherIncomeLines =
    otherIncomeSen !== 0
      ? allW.otherIncomeLines.map((ol) => ({ ...ol, amountSen: scale(ol.amountSen, R) }))
      : [];

  const expenseLines = allW.expenseLines.map((el) => ({
    ...el,
    amountSen: scale(el.amountSen, R),
  }));
  const expenseSen = expenseLines.reduce((s, el) => s + el.amountSen, 0);

  const netProfitSen = grossProfitSen + otherIncomeSen - expenseSen;

  return {
    netSalesSen,
    revLines,
    rmGroups,
    rmConsumedSen,
    carriageSen,
    sstSen,
    labourLines,
    labourSen,
    overheadLines,
    overheadSen,
    wipOpen,
    wipClose,
    fgOpen,
    fgClose,
    manufacturingSen,
    cogsSen,
    grossProfitSen,
    otherIncomeSen,
    otherIncomeLines,
    expenseLines,
    expenseSen,
    netProfitSen,
  };
}

/** Escape a JS value as a PostgreSQL single-quoted string. */
function pgStr(val) {
  const s = typeof val === "string" ? val : JSON.stringify(val);
  return "'" + s.replace(/'/g, "''") + "'";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const months = JSON.parse(readFileSync(INPUT, "utf8"));
console.log(`Loaded ${months.length} month(s) from ${INPUT}`);

const tieoutRows = [];
const sqlRows = [];

for (const m of months) {
  const allW = buildAllWindow(m);

  // Verify tie-out: computed netProfitSen must equal JSON's authoritative value
  const computedNet = allW.netProfitSen;
  const jsonNet = m.netProfitSen;
  const match = computedNet === jsonNet;
  tieoutRows.push({ ym: m.ym, computed: computedNet, json: jsonNet, match });
  if (!match) {
    console.error(
      `TIE-OUT FAIL ${m.ym}: computed=${computedNet} json=${jsonNet} diff=${computedNet - jsonNet}`,
    );
  }

  const sofaW = buildSplitWindow(allW, m, "sofa");
  const bedW = buildSplitWindow(allW, m, "bedframe");

  for (const [line, window] of [["all", allW], ["sofa", sofaW], ["bedframe", bedW]]) {
    const id = `pnlh-${m.ym}-${line}`;
    const windowJson = JSON.stringify(window);
    sqlRows.push(
      `INSERT INTO pnl_historical (id, org_id, ym, line, window_json, updated_at) VALUES ` +
      `(${pgStr(id)}, ${pgStr(ORG_ID)}, ${pgStr(m.ym)}, ${pgStr(line)}, ${pgStr(windowJson)}, ${pgStr(UPDATED_AT)}) ` +
      `ON CONFLICT (org_id, ym, line) DO UPDATE SET window_json = EXCLUDED.window_json, updated_at = EXCLUDED.updated_at;`,
    );
  }
}

// Print tie-out table
console.log("\n=== NET PROFIT TIE-OUT (all 13 months) ===");
let allPass = true;
for (const r of tieoutRows) {
  const status = r.match ? "PASS" : "FAIL";
  if (!r.match) allPass = false;
  console.log(
    `  ${r.ym}: computed=${r.computed} json=${r.json} diff=${r.computed - r.json} [${status}]`,
  );
}
console.log(allPass ? "\nAll 13 months: PASS" : "\nSome months FAILED — fix formula");

// Write SQL
mkdirSync(dirname(OUTPUT), { recursive: true });
const sqlContent =
  "-- Generated by scripts/build-historical-windows.mjs\n" +
  `-- updated_at fixed at: ${UPDATED_AT}\n` +
  "-- Run in Supabase SQL Editor (Project > SQL Editor > New query)\n\n" +
  sqlRows.join("\n") +
  "\n";

writeFileSync(OUTPUT, sqlContent, "utf8");
console.log(`\nWrote ${sqlRows.length} INSERT rows to ${OUTPUT}`);
if (sqlRows.length !== 39) {
  console.error(`WARNING: expected 39 rows (13 months × 3 lines), got ${sqlRows.length}`);
}
