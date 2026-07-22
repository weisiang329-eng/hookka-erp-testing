// Read-only audit (2026-07-22): Houzs "PO chasing list" vs the ERP hubs.
//
// Join key: their "Doc No" (PO-0096xx) -> sales_orders.customer_po_id.
// Compares their branch column ("Location": KL/PG/SRW/SBH) against the hub
// stamped on our sales order, then dumps the delivery documents of every
// mismatch so we can see whether the wrong address was actually printed.
//
// Input: po_map.json  { "PO-009112": { so:[..], locs:[..], qty:n }, ... }
// Usage: node scripts/audit-hok-hubs-2026-07-22.mjs <po_map.json>
import postgres from "postgres";
import fs from "node:fs";

// Connection string comes from the environment — never hardcoded here.
//   PowerShell:  $env:DATABASE_URL="postgresql://…"; node scripts/<this file>
const PROD = process.env.DATABASE_URL;
if (!PROD) throw new Error("set DATABASE_URL to the prod connection string");
const sql = postgres(PROD, { ssl: "require", max: 1, idle_timeout: 15 });

const map = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const pos = Object.keys(map).sort();

const rows = await sql`
  SELECT id, customer_po_id, customer_so_id, company_so_id, customer_state,
         hub_id, hub_name, status, created_at, updated_at
  FROM sales_orders WHERE customer_po_id = ANY(${pos})`;
const byPo = new Map(rows.map((r) => [r.customer_po_id, r]));

const HUB_FOR = { KL: "hub-h1", PG: "hub-h2", SRW: "hub-h3", SBH: "hub-h4" };
const wrong = [], multiLoc = [], missing = [], ok = [];
for (const po of pos) {
  const { so, locs } = map[po];
  const r = byPo.get(po);
  if (!r) { missing.push({ po, theirSo: so.join(","), loc: locs.join("/") }); continue; }
  if (locs.length > 1) { multiLoc.push({ po, locs, hub: r.hub_name }); continue; }
  const rec = { po, theirSo: so.join(","), theirLoc: locs[0], ourSo: r.company_so_id,
                ourRef: r.customer_so_id, ourHub: r.hub_name, status: r.status, soId: r.id };
  if (r.hub_id !== HUB_FOR[locs[0]]) wrong.push(rec); else ok.push(rec);
}

console.log(`chasing list: ${pos.length} POs | found in ERP: ${rows.length}`);
console.log(`HUB MATCH ${ok.length} | HUB WRONG ${wrong.length} | multi-location ${multiLoc.length} | not in ERP ${missing.length}\n`);
const dump = (l, a) => { console.log(`--- ${l} (${a.length}) ---`); for (const x of a) console.log(JSON.stringify(x)); console.log(); };
dump("HUB WRONG", wrong);
dump("multi-location PO", multiLoc);
dump("PO not in ERP", missing);

// Downstream impact of each mismatch: DOs, invoices, FG units.
for (const w of wrong) {
  console.log(`### ${w.po} / ${w.ourSo} — they say ${w.theirLoc}, we say ${w.ourHub} (${w.status})`);
  const dos = await sql`
    SELECT do_no, hub_name, customer_state, delivery_address, status, delivery_date
    FROM delivery_orders WHERE sales_order_id = ${w.soId}`;
  console.log("  DOs:", dos.length ? dos.map((d) => JSON.stringify(d)).join("\n       ") : "none");
  const fg = await sql`
    SELECT customer_hub, COUNT(*)::int n FROM fg_units WHERE so_id = ${w.soId} GROUP BY 1`;
  console.log("  FG units:", fg.length ? JSON.stringify(fg) : "none");
  const inv = await sql`
    SELECT invoice_no, status FROM invoices WHERE sales_order_id = ${w.soId}`;
  console.log("  invoices:", inv.length ? JSON.stringify(inv) : "none");
  console.log();
}
await sql.end();
