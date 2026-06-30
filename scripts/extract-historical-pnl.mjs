// scripts/extract-historical-pnl.mjs
// Phase 0: Extract historical P&L from owner's Excel into JSON.
// Run: node scripts/extract-historical-pnl.mjs

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const XLSX = require("C:/Users/User/OneDrive/Desktop/Claude/Hookka/repo/node_modules/xlsx");

const EXCEL_PATH = "C:/Users/User/OneDrive/Desktop/PNL 30.04.2026.xlsx";
const OUT_PATH = "scripts/out/historical-pnl.json";

// RM name → system group code map (from design doc §6)
const RM_CODE_MAP = {
  "B.M Fabric": "B.M-FABR",
  "S.M Fabric": "S.M-FABR",
  "S Fabric": "S-FABRIC",
  "Plywood": "PLYWOOD",
  "WD Strip": "WD STRIP",
  "B.Filler": "B.FILLER",
  "S.Filler": "S.FILLER",
  "B.Others": "B.OTHERS",
  "S.Others": "S.OTHERS",
  "B.Accessories": "B.ACCE",
  "Maintenance": "MAINTENA",
  "B.Mechanism": "B.MECHAN",
  "S.Mechanism": "S.MECH",
  "B.Webbing": "B.WEBB",
  "S.Webbing": "S.WEBB",
  "Packing": "PACKING",
};

// Month label → YYYY-MM
function parseYM(label) {
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04",
    May: "05", Jun: "06", Jul: "07", Aug: "08",
    Sep: "09", Sept: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  // e.g. "Apr'26", "Mar'26", "Sept'25"
  const m = label.match(/^([A-Za-z]+)'(\d{2})$/);
  if (!m) return null;
  const mon = months[m[1]];
  if (!mon) return null;
  const yr = parseInt(m[2], 10) + 2000;
  return `${yr}-${mon}`;
}

/** Convert RM float to integer sen */
function toSen(v) {
  if (v === "" || v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

/** Extract category name from "Opening Stock - <cat>" or "Closing Stock - <cat>" or "Purchase - <cat>" */
function extractCatFromLabel(label) {
  const m = label.match(/^(?:Opening Stock|Closing Stock|Purchase)\s*[-–]\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Look up code from RM name, lenient matching */
function rmCode(rawName) {
  // Direct match
  if (RM_CODE_MAP[rawName]) return { code: RM_CODE_MAP[rawName], unknown: false };
  // Try stripping trailing dots/spaces
  const stripped = rawName.replace(/[.\s]+$/, "");
  if (RM_CODE_MAP[stripped]) return { code: RM_CODE_MAP[stripped], unknown: false };
  // Case-insensitive match
  const lower = rawName.toLowerCase();
  for (const [k, v] of Object.entries(RM_CODE_MAP)) {
    if (k.toLowerCase() === lower) return { code: v, unknown: false };
  }
  console.warn(`[WARN] Unknown RM category: "${rawName}" — using raw name as code`);
  return { code: rawName, unknown: true };
}

// ─── Load workbook ─────────────────────────────────────────────────────────
const wb = XLSX.readFile(EXCEL_PATH, { cellDates: true });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });

// Row 5 (index 4) is the header: col3=Accumulated(skip), col5=Apr'26, col7=Mar'26, ...
const hdr = rows[4] || [];
const monthCols = []; // { idx, ym }
for (let c = 5; c < hdr.length; c += 2) {
  const label = String(hdr[c] ?? "").trim();
  const ym = parseYM(label);
  if (ym) monthCols.push({ idx: c, ym });
}

// Helper: get numeric value for a row at month column index
const val = (r, colIdx) => {
  const v = (rows[r] || [])[colIdx];
  return v === "" || v == null ? 0 : (typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, "")) || 0);
};

/** Return label text from row r (cols 0-2 concatenated) */
const labelOf = (r) =>
  [rows[r]?.[0], rows[r]?.[1], rows[r]?.[2]]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ");

// ─── Build month-keyed data ─────────────────────────────────────────────────
// Identify known row indices (1-based from reference output → 0-based)
const R = {
  salesBedframe: 7,    // row 8
  salesSofa: 8,        // row 9
  returnInward: 12,    // row 13
  discountAllowed: 13, // row 14
  openingFG: 18,       // row 19
  // RM groups: triples of [opening, purchase, closing] row indices (0-based)
  rmGroups: [
    // B.M Fabric
    { name: "B.M Fabric", rows: [22, 23, 24] },
    // S.M Fabric
    { name: "S.M Fabric", rows: [27, 28, 29] },
    // S Fabric
    { name: "S Fabric", rows: [32, 33, 34] },
    // Plywood
    { name: "Plywood", rows: [38, 39, 40] },
    // WD Strip
    { name: "WD Strip", rows: [43, 44, 45] },
    // B.Filler
    { name: "B.Filler", rows: [49, 50, 51] },
    // S.Filler
    { name: "S.Filler", rows: [54, 55, 56] },
    // B.Others
    { name: "B.Others", rows: [59, 60, 61] },
    // S.Others
    { name: "S.Others", rows: [64, 65, 66] },
    // B.Accessories
    { name: "B.Accessories", rows: [69, 70, 71] },
    // Maintenance
    { name: "Maintenance", rows: [74, 75, 76] },
    // B.Mechanism
    { name: "B.Mechanism", rows: [79, 80, 81] },
    // S.Mechanism
    { name: "S.Mechanism", rows: [84, 85, 86] },
    // B.Webbing
    { name: "B.Webbing", rows: [89, 90, 91] },
    // S.Webbing
    { name: "S.Webbing", rows: [94, 95, 96] },
    // Packing
    { name: "Packing", rows: [100, 101, 102] },
  ],
  // Labour sub-lines: Salaries, EPF, SOCSO, EIS (rows 109-112 → 0-based 108-111)
  labourRows: [108, 109, 110, 111],
  // Factory overhead sub-lines (rows 116-120 → 0-based 115-119)
  overheadRows: [115, 116, 117, 118, 119],
  wipOpen: 123,    // row 124
  wipClose: 124,   // row 125
  closingFG: 127,  // row 128
  // Other incomes sub-lines (rows 134-135 → 0-based 133-134)
  otherIncomeRows: [133, 134],
  // Expense sub-lines (rows 140-165 → 0-based 139-164, skip section headers)
  expenseStart: 139,
  expenseEnd: 164,
  // Section headers to skip
  expenseHeaders: new Set([149]), // "Salary, Contribution & Allowance" header row
  netProfit: 168, // row 169
};

// Verify RM group labels by checking actual sheet labels
for (const g of R.rmGroups) {
  const openLabel = labelOf(g.rows[0]);
  const cat = extractCatFromLabel(openLabel);
  if (cat && cat !== g.name) {
    // Try lenient: both might match via code map
    const fromSheet = rmCode(cat);
    const fromSpec = rmCode(g.name);
    if (fromSheet.code !== fromSpec.code) {
      console.warn(`[WARN] RM group name mismatch row ${g.rows[0]+1}: spec="${g.name}" sheet="${cat}"`);
    }
  }
}

// Overhead row labels (0-based indices 115-119 = rows 116-120)
const overheadLabels = R.overheadRows.map((ri) => labelOf(ri)).filter(Boolean);

// Expense section: rows 139-164 (0-based), skip blank labels and headers
const expenseRowIndices = [];
for (let ri = R.expenseStart; ri <= R.expenseEnd; ri++) {
  const lbl = labelOf(ri);
  if (!lbl) continue;
  if (R.expenseHeaders.has(ri)) continue;
  // Skip sub-total rows (no label → already filtered) and section headers
  expenseRowIndices.push({ ri, name: lbl });
}

// ─── Build one object per month ─────────────────────────────────────────────
const output = [];

for (const { idx, ym } of monthCols) {
  const g = (ri) => val(ri, idx);

  // RM categories
  const rmCategories = R.rmGroups.map(({ name, rows: [ro, rp, rc] }) => {
    const { code } = rmCode(name);
    return {
      name,
      code,
      openingSen: toSen(g(ro)),
      purchaseSen: toSen(g(rp)),
      // Closing is stored negative in sheet; store abs value
      closingSen: Math.abs(toSen(g(rc))),
    };
  });

  // Labour = sum of Salaries + EPF + SOCSO + EIS
  const labourSen = R.labourRows.reduce((sum, ri) => sum + toSen(g(ri)), 0);

  // Overhead lines
  const overheadLines = R.overheadRows.map((ri) => ({
    name: labelOf(ri),
    sen: toSen(g(ri)),
  })).filter((x) => x.name);

  // Other incomes = sum of sub-lines (Additional Income + Discount Received)
  const otherIncomeSen = R.otherIncomeRows.reduce((sum, ri) => sum + toSen(g(ri)), 0);

  // Expense lines (individual; caller can sum)
  const expenseLines = expenseRowIndices.map(({ ri, name }) => ({
    name,
    sen: toSen(g(ri)),
  }));

  output.push({
    ym,
    salesBedframeSen: toSen(g(R.salesBedframe)),
    salesSofaSen: toSen(g(R.salesSofa)),
    returnInwardSen: toSen(g(R.returnInward)),
    discountAllowedSen: toSen(g(R.discountAllowed)),
    openingFGSen: toSen(g(R.openingFG)),
    rmCategories,
    carriageSen: 0,
    sstSen: 0,
    labourSen,
    overheadLines,
    wipOpenSen: toSen(g(R.wipOpen)),
    wipCloseSen: Math.abs(toSen(g(R.wipClose))),
    closingFGSen: Math.abs(toSen(g(R.closingFG))),
    otherIncomeSen,
    expenseLines,
    netProfitSen: toSen(g(R.netProfit)),
  });
}

// Sort ascending: Apr'25 first, Apr'26 last
output.sort((a, b) => a.ym.localeCompare(b.ym));

// ─── Write output ────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
mkdirSync("scripts/out", { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

// ─── Verify ──────────────────────────────────────────────────────────────────
const apr26 = output.find((m) => m.ym === "2026-04");
if (!apr26) {
  console.error("VERIFY FAIL: no 2026-04 month found");
  process.exit(1);
}

console.log(`\nExtracted ${output.length} months (${output[0].ym} … ${output[output.length - 1].ym})`);
console.log(`\n=== VERIFY 2026-04 ===`);

let pass = true;
const checks = [
  { field: "netProfitSen", expected: -1409152 },
  { field: "salesBedframeSen", expected: 12476700 },
  { field: "salesSofaSen", expected: 8249300 },
];
for (const { field, expected } of checks) {
  const actual = apr26[field];
  const ok = actual === expected;
  console.log(`  ${field}: ${actual} (expected ${expected}) → ${ok ? "PASS" : "FAIL"}`);
  if (!ok) pass = false;
}

if (!pass) {
  console.error("\nVERIFY FAILED — fix parser before committing.");
  process.exit(1);
}

console.log("\nAll VERIFY checks PASSED.");
console.log(`Output written to ${OUT_PATH}`);
