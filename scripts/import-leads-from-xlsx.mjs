// ============================================================================
// import-leads-from-xlsx.mjs
//
// Turn a bought contact list (.xlsx) into leads, via POST /api/sales-leads/import.
//
// Built for SSM DATA Penang.xlsx — 1,029 rows scraped from Google Maps across
// four industry sheets, supplied 2026-08-19. Each SHEET is one industry, which
// is why the sheet name becomes the industry rather than the `job` column: the
// sheet split is the owner's own segmentation and the one he wants to work by.
//
// Report first. `--apply` is a separate, deliberate act:
//
//   node scripts/import-leads-from-xlsx.mjs "path/to/file.xlsx"
//   node scripts/import-leads-from-xlsx.mjs "path/to/file.xlsx" --apply --name Penang
//
// Needs API_BASE (e.g. https://staging.hookka-erp-testing.pages.dev) and a
// session cookie in HOOKKA_COOKIE. Deliberately goes through the API rather
// than the database directly, so the dedupe, the batch label and the
// "no customer is created" rule are the SAME ones the app enforces — a
// direct-to-DB import would quietly bypass all three.
// ============================================================================

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
const nameIdx = process.argv.indexOf("--name");
const batchName = nameIdx !== -1 ? process.argv[nameIdx + 1] : "import";

if (!file) {
  console.error("usage: node scripts/import-leads-from-xlsx.mjs <file.xlsx> [--apply] [--name Penang]");
  process.exit(1);
}

const API = process.env.API_BASE;
const COOKIE = process.env.HOOKKA_COOKIE;
if (!API || !COOKIE) {
  console.error("Set API_BASE and HOOKKA_COOKIE. Refusing to run.");
  process.exit(1);
}

// XLSX is read with the same library the app already depends on, so there is
// no second parser to disagree with the first.
let XLSX;
try {
  XLSX = require("xlsx");
} catch {
  console.error(
    "The `xlsx` package is not installed. Either `npm i -D xlsx`, or export the\n" +
      "sheets to CSV and import those — the API takes plain rows either way.",
  );
  process.exit(1);
}

const wb = XLSX.read(readFileSync(file), { type: "buffer" });

// Sheet name → industry. Anything unrecognised keeps the sheet name, so a new
// trade in a future list appears on its own rather than silently becoming
// "(none)".
const INDUSTRY_FROM_SHEET = (sheet) =>
  ({
    "PN-Furniture Retail": "Furniture Retail",
    "PN-interior Design": "Interior Design",
    "PN-Renovation": "Renovation",
    "PN-Airbnb-short stay": "Airbnb / Short Stay",
  })[sheet] ?? sheet.replace(/^[A-Z]{2}-/, "").trim();

const rows = [];
for (const sheet of wb.SheetNames) {
  const json = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: null });
  for (const r of json) {
    if (!r || Object.values(r).every((v) => v === null || v === "")) continue;
    rows.push({
      company: r["Business Name"] ?? null,
      phone: r["Business Phone"] ?? null,
      email: r["Business Email"] ?? null,
      website: r["Business Website"] ?? null,
      location: r["Location"] ?? null,
      industry: INDUSTRY_FROM_SHEET(sheet),
    });
  }
}

console.log(`file    : ${file}`);
console.log(`sheets  : ${wb.SheetNames.join(", ")}`);
console.log(`rows    : ${rows.length}`);
console.log(`mode    : ${APPLY ? "APPLY (writes)" : "REPORT ONLY"}`);
console.log("");

async function post(body) {
  const res = await fetch(`${API}/api/sales-leads/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: COOKIE },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`HTTP ${res.status} — response was not JSON:\n${text.slice(0, 400)}`);
    process.exit(1);
  }
  if (!res.ok || json.success === false) {
    console.error(`HTTP ${res.status}: ${json.error ?? text.slice(0, 200)}`);
    process.exit(1);
  }
  return json.data;
}

// Always plan first, even under --apply: the numbers get printed either way, so
// an import that turns out to be mostly duplicates is visible in the log rather
// than only in the outcome.
const plan = await post({ rows, dryRun: true });
const s = plan.summary;
console.log("--- what this import would do ---");
console.log(`  new leads                 ${String(s.insert).padStart(5)}`);
console.log(`  skipped, duplicate here   ${String(s.duplicateInFile).padStart(5)}`);
console.log(`  skipped, already in system${String(s.alreadyInSystem).padStart(5)}`);
console.log(`  skipped, no phone         ${String(s.noPhone).padStart(5)}`);
console.log(`  skipped, no company name  ${String(s.noCompany).padStart(5)}`);
console.log(`  of the new leads, no email${String(s.withoutEmail).padStart(5)}`);

if (s.withoutEmail === s.insert && s.insert > 0) {
  console.log(
    "\n  NOTE: every row in this list arrives without an email address, so none of\n" +
      "  them can be reached by email. Phone is the only channel this list supports.",
  );
}

if (!APPLY) {
  console.log("\nReport only — nothing was written.");
  console.log('Re-run with --apply --name "<list name>" to import.');
  process.exit(0);
}

console.log("\n--- importing ---");
const out = await post({ rows, batchName, source: "PURCHASED_LIST" });
console.log(`  batch label : ${out.batch}`);
console.log(`  inserted    : ${out.inserted}`);
console.log(
  `\nTo undo this entire import:\n  DELETE ${API}/api/sales-leads/import/${out.batch}`,
);
