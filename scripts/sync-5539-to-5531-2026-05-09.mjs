// Sync 5539 customer prices to match 5531 for the 10 common SKU types
// (1NA, 1A LHF/RHF, 2NA, 2A LHF/RHF, CNR, L LHF/RHF, STOOL).
// 5539-1B / 5539-2B (LHF + RHF, 4 SKUs) NOT touched — they have no 5531
// equivalent; await Wei Siang's pricing rule.
//
// EffectiveFrom = 2026-05-10 (same as 5531).
//
// Usage:
//   node scripts/sync-5539-to-5531-2026-05-09.mjs           # dry-run
//   node scripts/sync-5539-to-5531-2026-05-09.mjs --apply
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");
const EFFECTIVE_FROM = "2026-05-10";

const CUSTOMERS = [
  { id: "cust-2",        label: "Carress" },
  { id: "cust-f6c80b96", label: "2990 HOME" },
];

// 10 common component types (using 5531 prices verbatim as the source).
const COMMON_COMPONENTS = [
  "1NA", "1A(LHF)", "1A(RHF)",
  "2NA", "2A(LHF)", "2A(RHF)",
  "CNR", "L(LHF)", "L(RHF)", "STOOL",
];

// 5539 1B = 5531 1A + RM 150 per seat (Wei Siang 2026-05-09: "1B 就是 1R 的价格贵 150 块")
// 2B not yet ruled — handled as a separate component skipped by this script.
const B_VARIANTS = ["1B(LHF)", "1B(RHF)"]; // 2B(LHF)/2B(RHF) intentionally excluded
const B_SOURCE = { "1B(LHF)": "1A(LHF)", "1B(RHF)": "1A(RHF)" };
const B_DELTA_SEN = 15000; // +RM 150

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
  const session = await loginAndGetSession();

  // 1. Pull the 5531 customer-effective prices (effectiveFrom <= 2026-05-10) per
  //    customer + component. Copy them verbatim to the matching 5539 cp.
  const pricesByKey = new Map(); // key = customer_id::component → seat_height_prices array
  const r = await sql`
    SELECT cp.customer_id, p.code,
           (SELECT cpp.seat_height_prices
              FROM customer_product_prices cpp
             WHERE cpp.customer_product_id = cp.id
               AND cpp.effective_from <= ${EFFECTIVE_FROM}
             ORDER BY cpp.effective_from DESC, cpp.created_at DESC
             LIMIT 1) AS sh
      FROM customer_products cp
      JOIN products p ON p.id = cp.product_id
     WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${COMMON_COMPONENTS.map((c) => `5531-${c}`)})
  `;
  for (const row of r) {
    const comp = row.code.replace("5531-", "");
    pricesByKey.set(`${row.customer_id}::${comp}`, row.sh);
  }

  // 2. Get 5539 cp ids for each customer+component (common + B variants)
  const allCodes = [
    ...COMMON_COMPONENTS.map((c) => `5539-${c}`),
    ...B_VARIANTS.map((c) => `5539-${c}`),
  ];
  const cpRows = await sql`
    SELECT cp.id AS cp_id, cp.customer_id, p.code
      FROM customer_products cp JOIN products p ON p.id = cp.product_id
     WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${allCodes})
  `;
  const cpByKey = new Map();
  for (const row of cpRows) {
    const comp = row.code.replace("5539-", "");
    cpByKey.set(`${row.customer_id}::${comp}`, row.cp_id);
  }

  let inserted = 0;
  for (const cust of CUSTOMERS) {
    console.log(`\n========== ${cust.label} ==========`);

    // 10 common components — copy verbatim from 5531
    for (const comp of COMMON_COMPONENTS) {
      const sh = pricesByKey.get(`${cust.id}::${comp}`);
      const cpId = cpByKey.get(`${cust.id}::${comp}`);
      if (!sh) { console.error(`  ✗ no 5531 source for ${comp}`); continue; }
      if (!cpId) { console.error(`  ✗ no 5539 cp for ${comp}`); continue; }
      const arr = typeof sh === "string" ? JSON.parse(sh) : sh;
      const preview = arr.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
      console.log(`  5539-${comp.padEnd(10)} (= 5531)        ${preview}`);

      if (APPLY) {
        const r2 = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: EFFECTIVE_FROM,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: arr,
          notes: "5539 sync to 5531 — 10 common components",
          createdBy: "Wei Siang via 5539-to-5531 script",
        });
        if (!r2.ok) { console.error(`    ✗ POST ${cust.id}/${comp}: ${r2.status} ${JSON.stringify(r2.body)}`); process.exit(1); }
        inserted++;
      }
    }

    // 1B variants — = 1A + RM 150
    for (const bComp of B_VARIANTS) {
      const sourceComp = B_SOURCE[bComp];
      const sh = pricesByKey.get(`${cust.id}::${sourceComp}`);
      const cpId = cpByKey.get(`${cust.id}::${bComp}`);
      if (!sh) { console.error(`  ✗ no 5531 source for ${sourceComp} (needed for ${bComp})`); continue; }
      if (!cpId) { console.error(`  ✗ no 5539 cp for ${bComp}`); continue; }
      const sourceArr = typeof sh === "string" ? JSON.parse(sh) : sh;
      const arr = sourceArr.map((t) => ({
        height: t.height,
        priceSen: t.priceSen + B_DELTA_SEN,
        tier: t.tier,
      }));
      const preview = arr.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
      console.log(`  5539-${bComp.padEnd(10)} (1A+RM150)      ${preview}`);

      if (APPLY) {
        const r2 = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: EFFECTIVE_FROM,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: arr,
          notes: "5539-1B = 5531-1A + RM 150 (Wei Siang 2026-05-09)",
          createdBy: "Wei Siang via 5539-to-5531 script",
        });
        if (!r2.ok) { console.error(`    ✗ POST ${cust.id}/${bComp}: ${r2.status} ${JSON.stringify(r2.body)}`); process.exit(1); }
        inserted++;
      }
    }
  }

  console.log(`\nNOTE: 5539-2B(LHF) and 5539-2B(RHF) NOT touched — awaiting Wei Siang's pricing rule.`);

  console.log(APPLY
    ? `\nDONE — ${inserted} customer_product_prices history rows added (5539 common components, effective ${EFFECTIVE_FROM})`
    : "\nDONE — dry-run only.");
} finally {
  await sql.end();
}
