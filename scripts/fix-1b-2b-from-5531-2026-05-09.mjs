import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Final fix for 5539-1B and 5539-2B prices (Carress + 2990).
// Wei Siang clarification 2026-05-09:
//   1B = 5531-1R (= our 5531-1A) actual customer price + RM 150
//   2B = 5531-2R (= our 5531-2A) actual customer price + RM 150
// "你的 519.75 + 150 就对了" — the original sync-5539-to-5531 calculation
// (which used 5531 as the source) was correct. The fix-1b-2b "5535 + 150"
// approach was wrong.
//
// Action: DELETE the 8 wrong "5535+150" rows from earlier today + POST 8
// correct "5531+150" rows.
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";
const APPLY = process.argv.includes("--apply");
const EFFECTIVE_FROM = "2026-05-10";
const DELTA_SEN = 15000; // +RM 150

const CUSTOMERS = [
  { id: "cust-2",        label: "Carress" },
  { id: "cust-f6c80b96", label: "2990 HOME" },
];

const B_TO_SOURCE = {
  "1B(LHF)": "1A(LHF)",
  "1B(RHF)": "1A(RHF)",
  "2B(LHF)": "2A(LHF)",
  "2B(RHF)": "2A(RHF)",
};

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
  requiredDatabaseUrl("PROD_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
  const session = await loginAndGetSession();

  // 1. Find wrong rows
  const wrongRows = await sql`
    SELECT cpp.id AS price_row_id, cp.customer_id, p.code
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = ${EFFECTIVE_FROM}
       AND cpp.notes LIKE '%5535-%+ RM 150%'
       AND cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`Found ${wrongRows.length} wrong 1B/2B rows to delete`);

  // 2. Pull 5531-1A/2A current customer prices (the actual "1R/2R" values)
  const sourceCodes = ["5531-1A(LHF)", "5531-1A(RHF)", "5531-2A(LHF)", "5531-2A(RHF)"];
  const srcRows = await sql`
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
       AND p.code = ANY(${sourceCodes})
  `;
  const srcByKey = new Map();
  for (const r of srcRows) {
    srcByKey.set(`${r.customer_id}::${r.code.replace("5531-", "")}`, r.sh);
  }

  // 3. Get 5539 cp ids for B variants
  const bCodes = Object.keys(B_TO_SOURCE).map((c) => `5539-${c}`);
  const cpRows = await sql`
    SELECT cp.id AS cp_id, cp.customer_id, p.code
      FROM customer_products cp JOIN products p ON p.id = cp.product_id
     WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
       AND p.code = ANY(${bCodes})
  `;
  const cpByKey = new Map();
  for (const r of cpRows) {
    cpByKey.set(`${r.customer_id}::${r.code.replace("5539-", "")}`, r.cp_id);
  }

  // 4. Preview
  for (const cust of CUSTOMERS) {
    console.log(`\n========== ${cust.label} ==========`);
    for (const [bComp, srcComp] of Object.entries(B_TO_SOURCE)) {
      const sh = srcByKey.get(`${cust.id}::${srcComp}`);
      if (!sh) continue;
      const sourceArr = typeof sh === "string" ? JSON.parse(sh) : sh;
      const arr = sourceArr.map((t) => ({
        height: t.height,
        priceSen: t.priceSen + DELTA_SEN,
        tier: t.tier,
      }));
      const preview = arr.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
      console.log(`  5539-${bComp.padEnd(8)} (5531-${srcComp}+RM150)  ${preview}`);
    }
  }

  if (APPLY) {
    for (const r of wrongRows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) { console.error(`  ✗ DELETE: ${d.status}`); process.exit(1); }
    }
    console.log(`\n  deleted ${wrongRows.length}`);

    let inserted = 0;
    for (const cust of CUSTOMERS) {
      for (const [bComp, srcComp] of Object.entries(B_TO_SOURCE)) {
        const sh = srcByKey.get(`${cust.id}::${srcComp}`);
        const cpId = cpByKey.get(`${cust.id}::${bComp}`);
        const sourceArr = typeof sh === "string" ? JSON.parse(sh) : sh;
        const arr = sourceArr.map((t) => ({
          height: t.height,
          priceSen: t.priceSen + DELTA_SEN,
          tier: t.tier,
        }));
        const r2 = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: EFFECTIVE_FROM,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: arr,
          notes: `5539-${bComp} = 5531-${srcComp} customer price + RM 150 (Wei Siang 2026-05-09)`,
          createdBy: "Wei Siang via fix-1b-2b-from-5531",
        });
        if (!r2.ok) { console.error(`  ✗ POST: ${r2.status}`); process.exit(1); }
        inserted++;
      }
    }
    console.log(`  inserted ${inserted}`);
  }

  console.log(APPLY ? "\nDONE" : "\nDONE — dry-run only.");
} finally {
  await sql.end();
}
