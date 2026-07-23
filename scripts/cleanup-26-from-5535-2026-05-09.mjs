// Cleanup — remove 26" entries from the 24 customer_product_prices rows
// inserted earlier today by sync-5535-to-sf9055-2026-05-09.mjs.
//
// Strategy:
//   1. Find the 24 history rows by (customerProductId in 5535 components for
//      cust-2 + cust-f6c80b96, effectiveFrom = today, notes LIKE 'Sync to
//      SF 9055%').
//   2. DELETE each via the official API: DELETE /api/customer-products/
//      price-row/:priceRowId
//   3. POST replacements WITHOUT the 26" PRICE_2 entries — only 24/28/30
//      from SF 9055 + carried-over master 32/35 + PRICE_3 unchanged.
//
// Wei Siang 2026-05-09: "26" 全部无视, UI 没那个 cell 你就不该硬塞" —
// API insertion of values that have no UI cell is a back door violation.
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");

const SF9055_NO26 = {
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
const PRODUCT_CODES = Object.keys(SF9055_NO26);
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
  const csrfToken = j?.data?.csrfToken;
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return { csrfToken, cookieHeader };
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

  // Pull master tiers (we need PRICE_3 + PRICE_2 32/35 to carry over).
  const masterRows = await sql`
    SELECT id, code, seat_height_prices
      FROM products WHERE code = ANY(${PRODUCT_CODES})
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

  function buildOverrideNo26(code) {
    const sf = SF9055_NO26[code];
    const masterTiers = masterByCode.get(code) ?? [];
    const out = [];
    // Keep master rows EXCEPT the PRICE_2 24/28/30 ones we're overriding.
    // Also explicitly drop ANY 26 entry (master shouldn't have it but be safe).
    for (const t of masterTiers) {
      if (String(t.height) === "26") continue;
      if (t.tier === "PRICE_2" && (t.height in sf)) continue;
      out.push({ ...t });
    }
    for (const [h, p] of Object.entries(sf)) {
      out.push({ height: h, priceSen: p, tier: "PRICE_2" });
    }
    out.sort((a, b) => {
      const ha = Number(a.height) || 0, hb = Number(b.height) || 0;
      if (ha !== hb) return ha - hb;
      return String(a.tier).localeCompare(String(b.tier));
    });
    return out;
  }

  // Find today's 24 rows from sync-5535-to-sf9055
  const todaysRows = await sql`
    SELECT cpp.id AS price_row_id,
           cpp.customer_product_id AS cp_id,
           cp.customer_id,
           p.code,
           cpp.notes
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = ${today}
       AND cpp.notes LIKE 'Sync to SF 9055%'
       AND cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${PRODUCT_CODES})
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`\nFound ${todaysRows.length} today's history rows to clean up`);
  for (const r of todaysRows) {
    console.log(`  delete price_row=${r.price_row_id}  cust=${r.customer_id}  ${r.code}`);
  }

  if (todaysRows.length !== PRODUCT_CODES.length * CUSTOMERS.length) {
    console.warn(`  expected ${PRODUCT_CODES.length * CUSTOMERS.length} rows, got ${todaysRows.length} — verify before applying`);
  }

  if (APPLY) {
    // Step 1: DELETE today's 24 rows
    for (const r of todaysRows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) {
        console.error(`  ✗ DELETE ${r.price_row_id} HTTP ${d.status} ${JSON.stringify(d.body)}`);
        process.exit(1);
      }
    }
    console.log(`  deleted ${todaysRows.length} row(s)`);

    // Step 2: re-INSERT without 26
    const cpByKey = new Map();
    const cpRows = await sql`
      SELECT cp.id AS cp_id, cp.customer_id, p.code
        FROM customer_products cp
        JOIN products p ON p.id = cp.product_id
       WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
         AND p.code = ANY(${PRODUCT_CODES})
    `;
    for (const r of cpRows) cpByKey.set(`${r.customer_id}::${r.code}`, r.cp_id);

    let inserted = 0;
    for (const cust of CUSTOMERS) {
      for (const code of PRODUCT_CODES) {
        const cpId = cpByKey.get(`${cust.id}::${code}`);
        if (!cpId) {
          console.error(`  ✗ no cp for ${cust.id}/${code}`);
          process.exit(1);
        }
        const override = buildOverrideNo26(code);
        const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: today,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: override,
          notes: "Sync to SF 9055 (24/28/30 only — cleanup of 26 back-door)",
          createdBy: "Wei Siang via cleanup script",
        });
        if (!r.ok) {
          console.error(`  ✗ POST ${cust.id}/${code} HTTP ${r.status} ${JSON.stringify(r.body)}`);
          process.exit(1);
        }
        inserted++;
      }
    }
    console.log(`  inserted ${inserted} row(s) (24/28/30 only, no 26)`);
  }
  console.log(APPLY ? "\nDONE" : "\nDONE — dry-run only. Re-run with --apply.");
} finally {
  await sql.end();
}
