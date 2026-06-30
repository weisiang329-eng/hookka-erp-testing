// Build ONE combined opening-stock load SQL:
//   1) material_opening_stock  — RM opening per material (FIFO opening layer)
//   2) kv_config material_opening_date = 2026-04-30  (global cutover)
//   3) inventory_opening       — WIP/FG opening seed (Task 2.2)
//
// RM matching: the owner's 30/04 stock-take lists items by code/spec with a
// qty + unit price. We match each item to a raw_materials SKU by normalized
// item_code within the same item_group. Matched items seed that material's
// opening (qty + unit cost → drains via FIFO as production issues it). Any
// per-group value we can't code-match is distributed across that group's
// remaining SKUs so the group's opening still ties to the stock-take subtotal
// (4月 closing = 5月 opening).
//
//   node scripts/build-rm-opening-sql.mjs
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const XLSX = require("C:/Users/User/OneDrive/Desktop/Claude/Hookka/repo/node_modules/xlsx");

const RM_CSV = "C:/Users/User/Downloads/Supabase Snippet Untitled query (3).csv";
const STOCK = "C:/Users/User/Downloads/STOCK_TAKE_30_04_2026_categorized (2).xlsx";
const stock = JSON.parse(readFileSync("scripts/out/opening-stock.json", "utf8"));
const AS_OF = "2026-04-30";
const UPDATED = "2026-06-30T00:00:00.000Z";
const ORG = "hookka";

const CAT_CODE_MAP = { Plywood:"PLYWOOD", WD:"WD STRIP", Filler:"B.FILLER", "S.Filler":"S.FILLER", Others:"B.OTHERS", "S.Others":"S.OTHERS", Acc:"B.ACCE", ACC:"B.ACCE", "s.Mech":"S.MECH", Webb:"B.WEBB", "S.Webbing":"S.WEBB", Packing:"PACKING", SFabric:"S-FABRIC", Mfabric:"B.M-FABR", "S.MFabric":"S.M-FABR" };

// normalize a code for matching: upper, strip spaces, strip leading zeros in
// numeric "-" segments so PC151-2 == PC151-02.
const norm = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, "").split("-").map((p) => /^\d+$/.test(p) ? String(parseInt(p, 10)) : p).join("-");
const sen = (rm) => Math.round((Number(rm) || 0) * 100);

// --- raw_materials ---
const rmWb = XLSX.readFile(RM_CSV);
const rmRows = XLSX.utils.sheet_to_json(rmWb.Sheets[rmWb.SheetNames[0]], { defval: "" });
const byGroup = new Map();
const codeIndex = new Map(); // group -> Map<normCode, rmId>
for (const r of rmRows) {
  const g = String(r.item_group ?? "").trim();
  const id = String(r.id ?? "").trim();
  const code = String(r.item_code ?? "").trim();
  if (!g || !id) continue;
  if (!byGroup.has(g)) { byGroup.set(g, []); codeIndex.set(g, new Map()); }
  byGroup.get(g).push({ id, code });
  if (code && !codeIndex.get(g).has(norm(code))) codeIndex.get(g).set(norm(code), id);
}

// --- stock-take items ---
const stWb = XLSX.readFile(STOCK, { cellDates: true });
const stRows = XLSX.utils.sheet_to_json(stWb.Sheets["Apr26"], { header: 1, raw: true, defval: "" });
const items = [];
for (const r of stRows) {
  const cat = String(r[9] ?? "").trim();
  if (!cat || cat === "WIP" || cat === "FG") continue;
  const group = CAT_CODE_MAP[cat];
  if (!group) continue;
  const d0 = String(r[0] ?? "").trim();
  const qty = Number(r[3]) || 0;
  const total = Number(r[6]) || 0;
  if (total <= 0) continue;
  items.push({ group, code: d0, qty, valueSen: sen(total) });
}

// --- match + aggregate ---
const matched = new Map(); // rmId -> {qty, valueSen}
const matchedRmByGroup = new Map();
const unmatchedByGroup = new Map();
for (const it of items) {
  const rmId = codeIndex.get(it.group)?.get(norm(it.code));
  if (rmId) {
    const a = matched.get(rmId) ?? { qty: 0, valueSen: 0 };
    a.qty += it.qty; a.valueSen += it.valueSen; matched.set(rmId, a);
    if (!matchedRmByGroup.has(it.group)) matchedRmByGroup.set(it.group, new Set());
    matchedRmByGroup.get(it.group).add(rmId);
  } else {
    unmatchedByGroup.set(it.group, (unmatchedByGroup.get(it.group) ?? 0) + it.valueSen);
  }
}

// --- material_opening_stock rows ---
const mos = []; // {id, rmId, qty, unitCostSen}
for (const [rmId, a] of matched) {
  if (a.valueSen <= 0) continue;
  const qty = a.qty > 0 ? a.qty : 1;
  const unitCostSen = Math.round(a.valueSen / qty);
  mos.push({ id: `mos-${rmId}`, rmId, qty, unitCostSen });
}
// distribute unmatched remainder across each group's not-yet-seeded SKUs
const orphans = [];
for (const [group, remSen] of unmatchedByGroup) {
  if (remSen <= 0) continue;
  const skus = byGroup.get(group) ?? [];
  const seeded = matchedRmByGroup.get(group) ?? new Set();
  let targets = skus.filter((s) => !seeded.has(s.id));
  if (targets.length === 0) targets = skus; // all matched → fold remainder back in
  if (targets.length === 0) { orphans.push({ group, remSen }); continue; }
  const per = Math.floor(remSen / targets.length);
  let left = remSen;
  targets.forEach((s, i) => {
    const v = i === targets.length - 1 ? left : per;
    left -= v;
    if (v <= 0) return;
    const existing = mos.find((m) => m.rmId === s.id);
    if (existing) { // folding back into a matched SKU
      const newVal = existing.qty * existing.unitCostSen + v;
      existing.unitCostSen = Math.round(newVal / existing.qty);
    } else {
      mos.push({ id: `mos-${s.id}`, rmId: s.id, qty: 1, unitCostSen: v });
    }
  });
}

// --- report ---
const subtotalByGroup = new Map();
for (const c of stock.rmByCategory) subtotalByGroup.set(c.code, (subtotalByGroup.get(c.code) ?? 0) + c.closingSen);
console.log("=== per-group opening (sen) ===");
let grand = 0;
const targets = [...new Set(Object.values(CAT_CODE_MAP))];
for (const g of targets) {
  const matchedVal = [...matched.entries()].filter(([id]) => (matchedRmByGroup.get(g) ?? new Set()).has(id)).reduce((s, [, a]) => s + a.valueSen, 0);
  const unmatchedVal = unmatchedByGroup.get(g) ?? 0;
  const seededTotal = mos.filter((m) => byGroup.get(g)?.some((s) => s.id === m.rmId)).reduce((s, m) => s + m.qty * m.unitCostSen, 0);
  grand += seededTotal;
  const sub = subtotalByGroup.get(g) ?? 0;
  const tie = Math.abs(seededTotal - sub) <= 5 ? "OK" : `DIFF ${seededTotal - sub}`;
  console.log(`${g.padEnd(10)} matched=${String(matchedVal).padStart(9)} unmatched=${String(unmatchedVal).padStart(8)} seeded=${String(seededTotal).padStart(9)} subtotal=${String(sub).padStart(9)} ${tie}`);
}
console.log(`GRAND seeded RM = ${grand} sen (RM ${(grand/100).toFixed(2)}); stock-take RM subtotal Σ = ${[...subtotalByGroup.values()].reduce((a,b)=>a+b,0)}`);
console.log(`material_opening_stock rows: ${mos.length}`);
if (orphans.length) console.log("ORPHANS (no SKU in group, value lost):", orphans);

// --- emit SQL ---
const esc = (s) => String(s).replace(/'/g, "''");
const L = [];
L.push(`-- Combined opening-stock load (RM per-material + WIP/FG + opening date).`);
L.push(`-- Generated by scripts/build-rm-opening-sql.mjs. Run once in the PROD Supabase.`);
L.push(`-- RM opening matched from the 30/04 stock-take to raw_materials by item_code;`);
L.push(`-- unmatched per-group value distributed across the group's remaining SKUs.`);
L.push(`BEGIN;`);
L.push(`-- 1) Raw-material opening (authoritative full reload for this org).`);
L.push(`CREATE TABLE IF NOT EXISTS material_opening_stock (id TEXT PRIMARY KEY, rm_id TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL DEFAULT 0, unit_cost_sen INTEGER NOT NULL DEFAULT 0, as_of_date TEXT NOT NULL, org_id TEXT NOT NULL DEFAULT 'hookka', created_at TEXT, updated_at TEXT);`);
L.push(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mos_key ON material_opening_stock (org_id, rm_id);`);
L.push(`DELETE FROM material_opening_stock WHERE org_id = '${ORG}';`);
L.push(`INSERT INTO material_opening_stock (id, rm_id, qty, unit_cost_sen, as_of_date, org_id, updated_at) VALUES`);
L.push(mos.map((m) => `  ('${esc(m.id)}', '${esc(m.rmId)}', ${m.qty}, ${m.unitCostSen}, '${AS_OF}', '${ORG}', '${UPDATED}')`).join(",\n") + ";");
L.push(``);
L.push(`-- 2) Global cutover date (bare YYYY-MM-DD; the engine regex-validates it).`);
L.push(`INSERT INTO kv_config (key, value) VALUES ('material_opening_date', '${AS_OF}')`);
L.push(`ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
L.push(``);
L.push(`-- 3) WIP / finished-goods opening seed (idempotent re-include).`);
L.push(`CREATE TABLE IF NOT EXISTS inventory_opening (id TEXT PRIMARY KEY, org_id TEXT NOT NULL DEFAULT 'hookka', layer TEXT NOT NULL, value_sen INTEGER NOT NULL DEFAULT 0, as_of_date TEXT, updated_at TEXT);`);
L.push(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_opening_key ON inventory_opening (org_id, layer);`);
L.push(`INSERT INTO inventory_opening (id, org_id, layer, value_sen, as_of_date, updated_at) VALUES`);
L.push(`  ('invopen-hookka-WIP', '${ORG}', 'WIP', ${stock.wipSen}, '${AS_OF}', '${UPDATED}'),`);
L.push(`  ('invopen-hookka-FG',  '${ORG}', 'FG',  ${stock.fgSen}, '${AS_OF}', '${UPDATED}')`);
L.push(`ON CONFLICT (org_id, layer) DO UPDATE SET value_sen = EXCLUDED.value_sen, as_of_date = EXCLUDED.as_of_date, updated_at = EXCLUDED.updated_at;`);
L.push(`COMMIT;`);
writeFileSync("scripts/out/opening-load-combined.sql", L.join("\n") + "\n");
console.log("\nWrote scripts/out/opening-load-combined.sql");
