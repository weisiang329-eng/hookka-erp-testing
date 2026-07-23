// Strip 32/35 entries from Carress (cust-2) + 2990 HOME (cust-f6c80b96)
// 5535 customer_product_prices. Final state per Wei Siang 2026-05-09:
//
//   Each 5535 component for these 2 customers stores ONLY:
//     - PRICE_2 at 24/28/30 = SF 9055 supplier sheet values
//     - PRICE_3 at 24/28/30 = master 5535 values (unchanged)
//   Nothing for 26/32/35.
//
// Action: DELETE today's customer_product_prices rows (the cleanup-26
// rows) + POST replacements with the 24/28/30-only array.
//
// Usage:
//   node scripts/strip-32-35-from-5535-2026-05-09.mjs           # dry-run
//   node scripts/strip-32-35-from-5535-2026-05-09.mjs --apply   # write
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");

const KEEP_HEIGHTS = new Set(["24", "28", "30"]);

const SF9055_P2 = {
  "5535-1NA":     { 24:  50000, 28:  55000, 30:  55000 },
  "5535-2NA":     { 24: 100000, 28: 110000, 30: 110000 },
  "5535-1S":      { 24:  80500, 28:  85100, 30:  87400 },
  "5535-2S":      { 24: 115500, 28: 122100, 30: 125400 },
  "5535-3S":      { 24: 154000, 28: 162800, 30: 167200 },
  "5535-1A(LHF)": { 24:  55000, 28:  66000, 30:  66000 },
  "5535-1A(RHF)": { 24:  55000, 28:  66000, 30:  66000 },
  "5535-2A(LHF)": { 24: 105000, 28: 110000, 30: 121000 },
  "5535-2A(RHF)": { 24: 105000, 28: 110000, 30: 121000 },
  "5535-CNR":     { 24:  90000, 28:  90000, 30:  90000 },
  "5535-L(LHF)":  { 24: 105000, 28: 110000, 30: 115000 },
  "5535-L(RHF)":  { 24: 105000, 28: 110000, 30: 115000 },
};
const PRODUCT_CODES = Object.keys(SF9055_P2);
const CUSTOMERS = [
  { id: "cust-2",        label: "Carress" },
  { id: "cust-f6c80b96", label: "2990 HOME" },
];

async function loginAndGetSession() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const j = await res.json();
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { csrfToken: j?.data?.csrfToken, cookieHeader };
}
async function authedJson(session, method, path, body) {
  const headers = { "Content-Type": "application/json", Cookie: session.cookieHeader };
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = session.csrfToken;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: res.status, ok: res.ok, body: j };
}

const sql = postgres(
  "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres",
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
  const session = await loginAndGetSession();
  console.log("logged in OK");
  const today = new Date().toISOString().slice(0, 10);

  // master tiers (for PRICE_3 carry-over at 24/28/30)
  const masterRows = await sql`
    SELECT code, seat_height_prices FROM products WHERE code = ANY(${PRODUCT_CODES})
  `;
  const masterByCode = new Map();
  for (const r of masterRows) {
    let tiers = [];
    try {
      tiers = typeof r.seat_height_prices === "string"
        ? JSON.parse(r.seat_height_prices)
        : (Array.isArray(r.seat_height_prices) ? r.seat_height_prices : []);
    } catch {}
    masterByCode.set(r.code, tiers);
  }

  function buildOverride(code) {
    const sf = SF9055_P2[code];
    const masterTiers = masterByCode.get(code) ?? [];
    const out = [];
    // Master PRICE_3 entries — keep ONLY for 24/28/30. Drop 26/32/35.
    for (const t of masterTiers) {
      if (t.tier !== "PRICE_3") continue;
      const h = String(t.height);
      if (!KEEP_HEIGHTS.has(h)) continue;
      out.push({ ...t, height: h });
    }
    // SF 9055 PRICE_2 for 24/28/30
    for (const [h, p] of Object.entries(sf)) {
      out.push({ height: h, priceSen: p, tier: "PRICE_2" });
    }
    out.sort((a, b) => {
      const ha = Number(a.height), hb = Number(b.height);
      if (ha !== hb) return ha - hb;
      return String(a.tier).localeCompare(String(b.tier));
    });
    return out;
  }

  // Find today's existing rows from cleanup-26 (notes LIKE '%cleanup of 26%')
  const todaysRows = await sql`
    SELECT cpp.id AS price_row_id, cp.customer_id, p.code
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = ${today}
       AND cpp.notes LIKE '%24/28/30 only%'
       AND cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${PRODUCT_CODES})
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`\nFound ${todaysRows.length} today's cleanup-26 rows to replace`);

  if (APPLY) {
    for (const r of todaysRows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) { console.error(`  ✗ DELETE ${r.price_row_id}: ${d.status}`); process.exit(1); }
    }
    console.log(`  deleted ${todaysRows.length}`);

    const cpRows = await sql`
      SELECT cp.id AS cp_id, cp.customer_id, p.code
        FROM customer_products cp JOIN products p ON p.id = cp.product_id
       WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
         AND p.code = ANY(${PRODUCT_CODES})
    `;
    const cpByKey = new Map(cpRows.map((r) => [`${r.customer_id}::${r.code}`, r.cp_id]));
    let inserted = 0;
    for (const cust of CUSTOMERS) {
      for (const code of PRODUCT_CODES) {
        const cpId = cpByKey.get(`${cust.id}::${code}`);
        const override = buildOverride(code);
        const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: today,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: override,
          notes: "Final sync to SF 9055 — 24/28/30 only, no 26/32/35",
          createdBy: "Wei Siang via strip-32-35 script",
        });
        if (!r.ok) { console.error(`  ✗ POST ${cust.id}/${code}: ${r.status}`); process.exit(1); }
        inserted++;
      }
    }
    console.log(`  inserted ${inserted}`);
  }

  // Preview one component
  const previewCode = "5535-1A(LHF)";
  console.log(`\nFinal seat_height_prices for ${previewCode} (per customer):`);
  const ov = buildOverride(previewCode);
  for (const t of ov) console.log(`  ${String(t.height).padEnd(4)} ${String(t.tier).padEnd(8)} = RM ${(t.priceSen / 100).toFixed(2)}`);

  console.log(APPLY ? "\nDONE" : "\nDONE — dry-run only. Re-run with --apply.");
} finally {
  await sql.end();
}
