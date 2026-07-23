// Read-only: are sofa SETS being billed at the agreed combo price?
//
// sofa_combo_rules prices a SET (e.g. 2A + L at 28" = RM 2,200), not the sum of
// its pieces. runSofaComboPass discounts a matched group DOWN to that total, and
// is deliberately one-way: a group whose sum is already at or below the combo
// total is left alone. So a scanned PO that carries a lower price from the
// customer's own document is never lifted back up to our agreed set price.
//
// This checks every live SO's sofa groups against the rule that matches them.
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-sofa-combo-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 30 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

const rules = (await sql`SELECT * FROM sofa_combo_rules`).map((r) => ({
  ...r,
  sets: JSON.parse(r.component_sizes),
  prices: JSON.parse(r.prices_by_height),
}));

// A rule matches a group when every slot in component_sizes is filled by one of
// its accepted variants. Slots are order-independent.
function matchRule(customerId, baseModel, suffixes) {
  const cands = rules.filter(
    (r) => r.base_model === baseModel && (r.customer_id === customerId || r.customer_id == null),
  );
  for (const r of cands.sort((a, b) => (a.customer_id ? -1 : 1))) {
    const pool = [...suffixes];
    let ok = true;
    for (const slot of r.sets) {
      const i = pool.findIndex((s) => slot.includes(s));
      if (i < 0) { ok = false; break; }
      pool.splice(i, 1);
    }
    if (ok && pool.length === 0) return r;
  }
  return null;
}

const lines = await sql`
  SELECT so.id, so.company_so_id, so.customer_id, so.customer_name, so.status,
         (so.customer_po_image_b64 IS NOT NULL) AS from_scan,
         soi.line_no, soi.product_code, soi.size_code, soi.size_label,
         soi.quantity, soi.base_price_sen
    FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED' AND NOT COALESCE(so.is_service_order, false)
     AND soi.item_category = 'SOFA'
   ORDER BY so.company_so_id, soi.line_no`;

// Group by (SO, base model). product_code is "<model>-<suffix>".
const groups = new Map();
for (const l of lines) {
  const m = String(l.product_code ?? "").match(/^([^-]+)-(.+)$/);
  if (!m) continue;
  const key = `${l.id}|${m[1]}`;
  if (!groups.has(key)) groups.set(key, { so: l, model: m[1], items: [] });
  groups.get(key).items.push({ suffix: m[2], ...l });
}

const short = [], noRule = [];
let matched = 0;
for (const g of groups.values()) {
  const suffixes = g.items.flatMap((i) => Array(Math.max(1, Number(i.quantity) || 1)).fill(i.suffix));
  const rule = matchRule(g.so.customer_id, g.model, suffixes);
  if (!rule) { noRule.push(g); continue; }
  matched++;
  const height = String(g.items.find((i) => /^\d+$/.test(String(i.size_code ?? i.size_label ?? "")))?.size_code
    ?? g.items[0].size_label ?? "");
  const want = Number(rule.prices[height] ?? rule.prices[String(Number(height))] ?? 0);
  if (!want) continue;
  const got = g.items.reduce((t, i) => t + Number(i.base_price_sen || 0) * Number(i.quantity || 1), 0);
  if (got < want) short.push({ g, rule, height, want, got, delta: want - got });
}

console.log(`sofa groups: ${groups.size} | matched a combo rule: ${matched} | no rule: ${noRule.length}`);
console.log(`\n=== groups billed BELOW their agreed combo price (${short.length}) ===`);
let total = 0;
for (const s of short.sort((a, b) => b.delta - a.delta)) {
  total += s.delta;
  console.log(
    `  ${s.g.so.company_so_id} ${s.g.model} @${s.height}" ${s.g.so.customer_name} (${s.g.so.status}, scan=${s.g.so.from_scan}) ` +
      `billed ${rm(s.got)} vs combo ${rm(s.want)} → short ${rm(s.delta)}`,
  );
}
console.log(`  TOTAL short: ${rm(total)}`);
const scanShort = short.filter((s) => s.g.so.from_scan).length;
console.log(`  entry path: ${scanShort} scanned / ${short.length - scanShort} typed`);
await sql.end();
