// ---------------------------------------------------------------------------
// One-shot importer for the 6 production-dept CSVs Wei Siang dropped
// 2026-04-30 (FRAMING / FAB_CUT / FAB_SEW / UPHOLSTERY / WOOD_CUT / FOAM).
//
// Each CSV is a per-dept dump from the live Production Sheet with two extra
// columns the user filled in by hand:
//   - "Completed"  D/M/YYYY or DD/MM/YYYY (sometimes truncated to /202)
//   - "PIC 1" / "PIC 2"  full worker names
//
// We feed them to POST /api/import/job-card-completion (the historical
// migration endpoint), which marks the matching job_cards COMPLETED, fires
// the WIP-cascade + labor-ledger + FG-completion side effects, and is
// idempotent on re-run.
//
// Usage:  node scripts/import-prod-completions-2026-04-30.mjs --dry
//         node scripts/import-prod-completions-2026-04-30.mjs --live
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

const FILES = [
  ["FRAMING",    "C:/Users/User/Downloads/FRAMING-production-2026-04-30.csv"],
  ["FAB_CUT",    "C:/Users/User/Downloads/FAB_CUT-production-2026-04-30 (1).csv"],
  ["FAB_SEW",    "C:/Users/User/Downloads/FAB_SEW-production-2026-04-30.csv"],
  ["UPHOLSTERY", "C:/Users/User/Downloads/UPHOLSTERY-production-2026-04-30.csv"],
  ["WOOD_CUT",   "C:/Users/User/Downloads/WOOD_CUT-production-2026-04-30.csv"],
  ["FOAM",       "C:/Users/User/Downloads/FOAM-production-2026-04-30 (1).csv"],
];

// Reverse map: full worker name → existing WORKER_NAME_MAP key (short or
// self-referencing full). The endpoint's WORKER_NAME_MAP only knows the
// shorts, so we translate before sending.
const FULL_TO_SHORT = {
  "EI PHOO WEI":      "PHOO",
  "ZIN MIN NWE":      "ZIN",
  "ZIN MIN NEW":      "ZIN",          // user typo seen in CSV
  "ANN":              "ANN",
  "OO SAN YEE":       "YEE",
  "PHYU SIN MOE":     "PHYU",
  "KHIN AYE MU":      "KHIN",
  "OHN MAR SHEIN":    "SHEIN",
  "KHIN MAUNG LIN":   "LIN",
  "KYAW OO":          "KYAW OO",
  "AUNG KO MYINT":    "AUNG KO MYINT",
  "AUNG KO OO":       "AUNG KO OO",
  "MYINT TUN":        "AZAW",
  "NYEIN CHAN AUNG":  "THAR",
  "ZAW LIN":          "ZAW LIN",
  "HLAING MIN AUNG":  "MIN",
  "ZAW MOE TUN":      "ZAW MOE",
  "YE LI SOE":        "YE LI SOE",
  "AUNG KYAW SOE":    "KYAW",
  "AUNG THEIN WIN":   "AUNG",
  "A MANG":           "AMANG",
  // Names not in the original WORKER_NAME_MAP — we send them through the
  // `selfFullName` pseudo-key. The endpoint will warn unless the route's
  // WORKER_NAME_MAP gets matching self-referencing entries deployed.
  "CHAE KO KO":       "CHAE KO KO",
  "KYAR TUN HLA":     "KYAR TUN HLA",
  "KYAW ZIN OO":      "KYAW ZIN OO",
};

// CSV WIP label → wipType (matches src/api/lib/bom-wip-breakdown.ts).
function inferWipType(wipLabel, category) {
  const s = String(wipLabel || "").toLowerCase();
  if (s.includes("divan")) return "DIVAN";
  if (s.includes(" hb ") || s.includes("-hb ") || s.includes("hb\"") || /\bhb\b/.test(s) || s.includes("headboard")) return "HEADBOARD";
  if (s.includes("base"))         return "SOFA_BASE";
  if (s.includes("back cushion")) return "SOFA_CUSHION";
  if (s.includes("backrest"))     return "SOFA_CUSHION";
  if (s.includes("arm"))          return "SOFA_ARMREST";
  // Fallback by category.
  if (String(category).toUpperCase() === "BEDFRAME") return null; // ambiguous
  return null;
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let cur = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") {}
      else field += c;
    }
  }
  if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

// "21/4/2026" or "21/04/2026" → "2026-04-21". "29/04/202" → "2026-04-29"
// (treated as a CSV cell truncation; warned).
//
// Locale detection: the user's Google Sheet flipped to mm/dd/yyyy on some
// rows (US-locale auto-detect after a paste). We assume dd/mm first; if
// that produces a future date (> today) AND mm/dd gives a date ≤ today,
// we flip to mm/dd. If both give future, warn + skip.
const TODAY = "2026-04-30";

function normDate(d, warnings) {
  const s = String(d || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) {
    warnings.push(`unparseable date "${s}"`);
    return null;
  }
  let year = m[3];
  if (year.length === 3 && year === "202") {
    warnings.push(`truncated year "${s}" → assumed 2026`);
    year = "2026";
  } else if (year.length === 2) {
    year = `20${year}`;
  }
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const mk = (day, mon) => `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const ddmm = mk(a, b);
  // If 'a' > 12, only ddmm is valid.
  if (a > 12) return ddmm;
  // If 'b' > 12, must be mm/dd.
  if (b > 12) return mk(b, a);
  // Both ambiguous (≤12). Prefer ddmm, but flip if it lands in the future
  // and mm/dd gives a sane past date.
  if (ddmm <= TODAY) return ddmm;
  const mmdd = mk(b, a);
  if (mmdd <= TODAY) {
    warnings.push(`flipped "${s}" from dd/mm (${ddmm}, future) to mm/dd (${mmdd})`);
    return mmdd;
  }
  warnings.push(`date "${s}" is future on both interpretations (dd/mm=${ddmm}, mm/dd=${mmdd}) — skipped`);
  return null;
}

function picToShort(name, warnings) {
  const t = String(name || "").trim().toUpperCase();
  if (!t) return null;
  const mapped = FULL_TO_SHORT[t];
  if (!mapped) {
    warnings.push(`PIC name "${t}" not in FULL_TO_SHORT — sending raw`);
    return t;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Build payload
// ---------------------------------------------------------------------------
function buildRows() {
  const groupKey = (custRef, productCode, dept, wipType) =>
    `${custRef}|${productCode}|${dept}|${wipType ?? ""}`;

  const groups = new Map(); // key → { custRef, productCode, dept, wipTypes:Set, completedDate, pic1, pic2, sourceLabels:[] }
  const warnings = [];
  const skipped = [];
  let totalCsvFilledRows = 0;

  for (const [dept, file] of FILES) {
    const txt = fs.readFileSync(file, "utf8");
    const rows = parseCSV(txt);
    const header = rows[0];
    const idx = (n) => header.indexOf(n);
    const I = {
      custPO: idx("Customer PO"),
      custRef: idx("Customer Ref"),
      soNo: idx("PO No"),
      model: idx("Model"),
      wip: idx("WIP"),
      cat: idx("Category"),
      completed: idx("Completed"),
      pic1: idx("PIC 1"),
      pic2: idx("PIC 2"),
    };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 2) continue;
      const completedRaw = (row[I.completed] || "").trim();
      const pic1Raw = (row[I.pic1] || "").trim();
      const pic2Raw = (row[I.pic2] || "").trim();
      if (!completedRaw && !pic1Raw && !pic2Raw) continue;
      totalCsvFilledRows++;

      const custRef = (row[I.custRef] || "").trim();
      const productCode = (row[I.model] || "").trim();
      const wipLabel = (row[I.wip] || "").trim();
      const cat = (row[I.cat] || "").trim();
      const wipType = inferWipType(wipLabel, cat);
      const completedDate = normDate(completedRaw, warnings);

      if (!custRef || !productCode) {
        skipped.push({ dept, csvRow: r + 1, reason: "missing custRef or productCode", wipLabel });
        continue;
      }
      if (!wipType) {
        skipped.push({ dept, csvRow: r + 1, reason: "could not infer wipType", wipLabel, cat });
        continue;
      }

      const pic1 = pic1Raw ? picToShort(pic1Raw, warnings) : null;
      const pic2 = pic2Raw ? picToShort(pic2Raw, warnings) : null;

      const key = groupKey(custRef, productCode, dept, wipType);
      let g = groups.get(key);
      if (!g) {
        g = {
          custRef, productCode, dept, wipType,
          completedDate, pic1, pic2,
          sourceLabels: [],
        };
        groups.set(key, g);
      } else {
        // Merge: latest non-null date wins (string compare works on ISO).
        if (completedDate && (!g.completedDate || completedDate > g.completedDate)) {
          g.completedDate = completedDate;
        }
        // PICs: first non-null wins for slot 1; slot 2 same.
        if (!g.pic1 && pic1) g.pic1 = pic1;
        if (!g.pic2 && pic2) g.pic2 = pic2;
      }
      g.sourceLabels.push(wipLabel);
    }
  }

  const inputRows = [];
  for (const g of groups.values()) {
    inputRows.push({
      customerRef: g.custRef,
      productCode: g.productCode,
      deptCode: g.dept,
      wipTypes: g.wipType ? [g.wipType] : undefined,
      completedDate: g.completedDate ?? "",
      pic1Name: g.pic1 ?? "",
      pic2Name: g.pic2 ?? "",
    });
  }

  return { inputRows, warnings, skipped, totalCsvFilledRows };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function login() {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j?.data?.token) throw new Error(`login failed: ${JSON.stringify(j)}`);
  return j.data.token;
}

async function postBatch(token, rows, dryRun) {
  // Endpoint chunks server-side via ?cursor/?limit. We send the whole rows
  // array per call and loop through pages.
  let cursor = 0;
  const totals = {
    matched: 0, noSoMatch: 0, noJcMatch: 0,
    jcUpdated: 0, posCompleted: 0,
    errors: [], picWarnings: [],
  };
  while (true) {
    const url = `${PROD}/api/import/job-card-completion?cursor=${cursor}&limit=100`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ dryRun, rows }),
    });
    const j = await r.json();
    if (!j?.success) {
      console.error("API error:", j);
      throw new Error(`API failed at cursor=${cursor}`);
    }
    totals.matched      += j.matched      || 0;
    totals.noSoMatch    += j.noSoMatch    || 0;
    totals.noJcMatch    += j.noJcMatch    || 0;
    totals.jcUpdated    += j.jcUpdated    || 0;
    totals.posCompleted += j.posCompleted || 0;
    totals.errors.push(...(j.errors || []));
    totals.picWarnings.push(...(j.picWarnings || []));
    process.stdout.write(
      `  cursor=${cursor}  matched=${j.matched}  noSO=${j.noSoMatch}  noJC=${j.noJcMatch}  jcUpd=${j.jcUpdated}  posDone=${j.posCompleted}  picWarn=${(j.picWarnings||[]).length}  err=${(j.errors||[]).length}\n`,
    );
    if (!j.cursor?.hasMore) break;
    cursor = parseInt(j.cursor.nextCursor, 10);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const mode = process.argv.includes("--live") ? "live"
           : process.argv.includes("--dry")  ? "dry"
           : null;
if (!mode) {
  console.error("Pass --dry or --live");
  process.exit(2);
}

const { inputRows, warnings, skipped, totalCsvFilledRows } = buildRows();

console.log(`Built ${inputRows.length} grouped input rows from ${totalCsvFilledRows} filled CSV rows.`);
console.log(`CSV → API skipped: ${skipped.length}`);
console.log(`Local pre-processing warnings: ${warnings.length}`);

// Save the payload + skip log for inspection.
const outDir = "tmp";
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "import-payload-2026-04-30.json"), JSON.stringify(inputRows, null, 2));
fs.writeFileSync(path.join(outDir, "import-skipped-2026-04-30.json"), JSON.stringify(skipped, null, 2));
fs.writeFileSync(path.join(outDir, "import-warnings-2026-04-30.json"), JSON.stringify(warnings, null, 2));

// Per-dept counts for sanity.
const perDept = {};
for (const r of inputRows) perDept[r.deptCode] = (perDept[r.deptCode] || 0) + 1;
console.log("Per-dept input row counts:", perDept);

console.log(`\nLogging in to ${PROD} ...`);
const token = await login();
console.log("Got token.");

const dry = mode === "dry";
console.log(`\n=== ${dry ? "DRY-RUN" : "LIVE"} import — ${inputRows.length} rows ===`);
const totals = await postBatch(token, inputRows, dry);

console.log("\n=== Totals ===");
console.log(JSON.stringify({
  matched: totals.matched,
  noSoMatch: totals.noSoMatch,
  noJcMatch: totals.noJcMatch,
  jcUpdated: totals.jcUpdated,
  posCompleted: totals.posCompleted,
  picWarnings: totals.picWarnings.length,
  errors: totals.errors.length,
}, null, 2));

// Persist full output for inspection.
fs.writeFileSync(path.join(outDir, `import-result-${dry ? "dry" : "live"}-2026-04-30.json`), JSON.stringify(totals, null, 2));
console.log(`Full result written to tmp/import-result-${dry ? "dry" : "live"}-2026-04-30.json`);
