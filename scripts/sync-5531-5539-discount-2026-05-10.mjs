// Apply Wei Siang 2026-05-09 directive: Carress (cust-2) + 2990 HOME
// (cust-f6c80b96) get 5531 + 5539 customer prices derived from 5535:
//
//   5531: 13 components
//     - 1S / 2S / 3S         = 5535 price as-is (no discount)
//     - All other 10         = 5535 price × 0.945  (5.5% off)
//
//   5539: 8 components (no 1S/2S/3S/2NA/STOOL exist in master)
//     - All 8                = 5535 price × 0.945
//
// Source = the 5535 customer override that was just synced today (24/28/30
// PRICE_2 only). EffectiveFrom = TOMORROW (2026-05-10).
//
// Usage:
//   node scripts/sync-5531-5539-discount-2026-05-10.mjs           # dry-run
//   node scripts/sync-5531-5539-discount-2026-05-10.mjs --apply
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");
const EFFECTIVE_FROM = "2026-05-10"; // tomorrow

const CUSTOMERS = [
  { id: "cust-2",        label: "Carress" },
  { id: "cust-f6c80b96", label: "2990 HOME" },
];

// 5535 baseline (sen) per component × seat. Match what we just synced.
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

// Components per model
const FIVE531_COMPONENTS = [
  "1NA", "1A(LHF)", "1A(RHF)", "1S",
  "2NA", "2A(LHF)", "2A(RHF)", "2S",
  "3S", "CNR", "L(LHF)", "L(RHF)", "STOOL",
];
const FIVE539_COMPONENTS = [
  "1NA", "1A(LHF)", "1A(RHF)",
  "2A(LHF)", "2A(RHF)",
  "CNR", "L(LHF)", "L(RHF)",
];

// 1S / 2S / 3S follow 5535 verbatim. Everything else applies 5.5% discount.
// Integer sen math: priceSen × 945 / 1000.
const NO_DISCOUNT = new Set(["1S", "2S", "3S"]);
function priceFor(component, seat) {
  const base = FIVE535[component][seat];
  if (NO_DISCOUNT.has(component)) return base;
  return Math.round(base * 945 / 1000); // 5.5% off
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
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
  console.log(`effectiveFrom: ${EFFECTIVE_FROM}`);
  const session = await loginAndGetSession();

  // Pull all 42 cp ids (Carress 5531+5539 + 2990 5531+5539)
  const allCodes = [
    ...FIVE531_COMPONENTS.map((c) => `5531-${c}`),
    ...FIVE539_COMPONENTS.map((c) => `5539-${c}`),
  ];
  const cpRows = await sql`
    SELECT cp.id AS cp_id, cp.customer_id, p.code
      FROM customer_products cp JOIN products p ON p.id = cp.product_id
     WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${allCodes})
  `;
  const cpByKey = new Map(cpRows.map((r) => [`${r.customer_id}::${r.code}`, r.cp_id]));
  const expected = (FIVE531_COMPONENTS.length + FIVE539_COMPONENTS.length) * CUSTOMERS.length;
  if (cpByKey.size !== expected) {
    console.error(`expected ${expected} cp rows, got ${cpByKey.size} — aborting`);
    process.exit(1);
  }

  let inserted = 0;
  for (const cust of CUSTOMERS) {
    console.log(`\n========== ${cust.label} (${cust.id}) ==========`);
    for (const [model, components] of [["5531", FIVE531_COMPONENTS], ["5539", FIVE539_COMPONENTS]]) {
      for (const c of components) {
        const code = `${model}-${c}`;
        const cpId = cpByKey.get(`${cust.id}::${code}`);
        const override = buildOverride(c);
        const tag = NO_DISCOUNT.has(c) ? " (=5535)" : " (×0.945)";
        const preview = override.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
        console.log(`  ${code.padEnd(15)}${tag.padEnd(10)} ${preview}`);

        if (APPLY) {
          const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
            effectiveFrom: EFFECTIVE_FROM,
            basePriceSen: null,
            price1Sen: null,
            seatHeightPrices: override,
            notes: "Sync 5531/5539 from 5535 — 1S/2S/3S verbatim, others 5.5% off",
            createdBy: "Wei Siang via 5531-5539-discount script",
          });
          if (!r.ok) { console.error(`    ✗ POST: ${r.status} ${JSON.stringify(r.body)}`); process.exit(1); }
          inserted++;
        }
      }
    }
  }

  if (APPLY) console.log(`\nDONE — ${inserted} customer_product_prices history rows added (effectiveFrom=${EFFECTIVE_FROM})`);
  else console.log("\nDONE — dry-run only. Re-run with --apply.");
} finally {
  await sql.end();
}
