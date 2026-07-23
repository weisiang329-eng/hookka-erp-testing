// Update 5531 customer prices for Carress + 2990 — Wei Siang 2026-05-09 final:
//   - All components ×0.945 (5.5% off 5535 base)  [includes 1S, 2S now]
//   - 3S 24" manual override = RM 1512.00
//   - 3S 28" / 30" = 5535 verbatim (no discount)
// EffectiveFrom = 2026-05-10 (tomorrow).
//
// Action: DELETE today's "Sync 5531/5539" rows for 5531 components +
// POST replacements with the new rule.
//
// Usage:
//   node scripts/update-5531-pricing-2026-05-09.mjs           # dry-run
//   node scripts/update-5531-pricing-2026-05-09.mjs --apply
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");
const EFFECTIVE_FROM = "2026-05-10";

const CUSTOMERS = [
  { id: "cust-2",        label: "Carress" },
  { id: "cust-f6c80b96", label: "2990 HOME" },
];

// 5535 base prices in sen (the source for the ×0.945 calculation).
const FIVE535 = {
  "1NA":     { 24:  50000, 28:  55000, 30:  55000 },
  "1A(LHF)": { 24:  55000, 28:  66000, 30:  66000 },
  "1A(RHF)": { 24:  55000, 28:  66000, 30:  66000 },
  "1S":      { 24:  80500, 28:  85100, 30:  87400 },
  "2NA":     { 24: 100000, 28: 110000, 30: 110000 },
  "2A(LHF)": { 24: 105000, 28: 110000, 30: 121000 },
  "2A(RHF)": { 24: 105000, 28: 110000, 30: 121000 },
  "2S":      { 24: 115500, 28: 122100, 30: 125400 },
  "3S":      { 24: 154000, 28: 162800, 30: 167200 },
  "CNR":     { 24:  90000, 28:  90000, 30:  90000 },
  "L(LHF)":  { 24: 105000, 28: 110000, 30: 115000 },
  "L(RHF)":  { 24: 105000, 28: 110000, 30: 115000 },
  "STOOL":   { 24:  50000, 28:  50000, 30:  50000 },
};
const COMPONENTS = Object.keys(FIVE535);

// Rule:
//   default          → 5535 × 0.945
//   3S 24"           → 151200 sen (manual, RM 1512)
//   3S 28" / 30"     → 5535 verbatim (no discount)
function priceFor(component, seat) {
  if (component === "3S" && seat === 24) return 151200;
  if (component === "3S") return FIVE535[component][seat]; // 28, 30 verbatim
  return Math.round(FIVE535[component][seat] * 945 / 1000);
}

function buildOverride(component) {
  return [24, 28, 30].map((h) => ({
    height: String(h),
    priceSen: priceFor(component, h),
    tier: "PRICE_2",
  }));
}

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

  // 1. Find today's 5531 rows from previous sync to DELETE
  const oldRows = await sql`
    SELECT cpp.id AS price_row_id, cp.customer_id, p.code
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = ${EFFECTIVE_FROM}
       AND cpp.notes LIKE 'Sync 5531/5539 from 5535%'
       AND cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code LIKE '5531-%'
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`\nFound ${oldRows.length} previous-rule 5531 row(s) to replace`);

  // 2. Get cp ids for re-INSERT
  const codes = COMPONENTS.map((c) => `5531-${c}`);
  const cpRows = await sql`
    SELECT cp.id AS cp_id, cp.customer_id, p.code
      FROM customer_products cp JOIN products p ON p.id = cp.product_id
     WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${codes})
  `;
  const cpByKey = new Map(cpRows.map((r) => [`${r.customer_id}::${r.code}`, r.cp_id]));

  // 3. Preview new rule
  for (const cust of CUSTOMERS) {
    console.log(`\n========== ${cust.label} ==========`);
    for (const c of COMPONENTS) {
      const code = `5531-${c}`;
      const o = buildOverride(c);
      let tag = "(×0.945)";
      if (c === "3S") tag = "(3S: 24=1512 manual, 28/30 = 5535)";
      const preview = o.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
      console.log(`  ${code.padEnd(15)} ${tag.padEnd(38)} ${preview}`);
    }
  }

  if (APPLY) {
    for (const r of oldRows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) { console.error(`  ✗ DELETE ${r.price_row_id}: ${d.status}`); process.exit(1); }
    }
    console.log(`\n  deleted ${oldRows.length}`);
    let inserted = 0;
    for (const cust of CUSTOMERS) {
      for (const c of COMPONENTS) {
        const code = `5531-${c}`;
        const cpId = cpByKey.get(`${cust.id}::${code}`);
        const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: EFFECTIVE_FROM,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: buildOverride(c),
          notes: "5531 final pricing — all ×0.945, 3S 24=1512 manual, 3S 28/30 = 5535",
          createdBy: "Wei Siang via update-5531 script",
        });
        if (!r.ok) { console.error(`  ✗ POST ${cust.id}/${code}: ${r.status} ${JSON.stringify(r.body)}`); process.exit(1); }
        inserted++;
      }
    }
    console.log(`  inserted ${inserted}`);
  }
  console.log(APPLY ? "\nDONE" : "\nDONE — dry-run only.");
} finally {
  await sql.end();
}
