// Assign 5539-1S to Carress + 2990, customer prices = 5531-1S verbatim.
// Wei Siang 2026-05-09 just created 1S in 5539 master.
// Effective 2026-05-10.
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
const COMPONENTS = ["1S"];

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

  const codes = COMPONENTS.map((c) => `5539-${c}`);
  const prods = await sql`SELECT id, code FROM products WHERE code = ANY(${codes})`;
  const prodIdByCode = new Map(prods.map((p) => [p.code, p.id]));
  for (const code of codes) {
    if (!prodIdByCode.has(code)) {
      console.error(`✗ master ${code} not found — abort`);
      process.exit(1);
    }
  }

  const sourceCodes = COMPONENTS.map((c) => `5531-${c}`);
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

  console.log("\nStep A: bulk-assign");
  const productIds = COMPONENTS.map((c) => prodIdByCode.get(`5539-${c}`));
  for (const cust of CUSTOMERS) {
    if (APPLY) {
      const r = await authedJson(session, "POST", "/api/customer-products/bulk-assign", {
        customerId: cust.id,
        productIds,
      });
      if (!r.ok) { console.error(`  ✗ ${cust.id}: ${r.status}`); process.exit(1); }
      console.log(`  ${cust.label}: ${JSON.stringify(r.body.data)}`);
    } else {
      console.log(`  ${cust.label}: would bulk-assign ${productIds.length} (5539-1S)`);
    }
  }

  console.log("\nStep B: customer prices (5531 → 5539 verbatim)");
  let cpByKey = new Map();
  if (APPLY) {
    const cpRows = await sql`
      SELECT cp.id AS cp_id, cp.customer_id, p.code
        FROM customer_products cp JOIN products p ON p.id = cp.product_id
       WHERE cp.customer_id = ANY(${CUSTOMERS.map((c) => c.id)})
         AND p.code = ANY(${codes})
    `;
    cpByKey = new Map(cpRows.map((r) => [`${r.customer_id}::${r.code.replace("5539-", "")}`, r.cp_id]));
  }

  let inserted = 0;
  for (const cust of CUSTOMERS) {
    for (const comp of COMPONENTS) {
      const sh = srcByKey.get(`${cust.id}::${comp}`);
      if (!sh) { console.error(`  ✗ no 5531 source for ${cust.id} ${comp}`); continue; }
      const arr = typeof sh === "string" ? JSON.parse(sh) : sh;
      const preview = arr.map((t) => `${t.height}=${(t.priceSen/100).toFixed(2)}`).join("  ");
      console.log(`  5539-${comp.padEnd(3)} ${cust.label.padEnd(12)} ${preview}`);

      if (APPLY) {
        const cpId = cpByKey.get(`${cust.id}::${comp}`);
        if (!cpId) { console.error(`  ✗ no cp_id after bulk-assign for ${cust.id}/${comp}`); process.exit(1); }
        const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: EFFECTIVE_FROM,
          basePriceSen: null,
          price1Sen: null,
          seatHeightPrices: arr,
          notes: `5539-${comp} = 5531-${comp} verbatim (Wei Siang 2026-05-09)`,
          createdBy: "Wei Siang via assign-5539-1s",
        });
        if (!r.ok) { console.error(`  ✗ POST: ${r.status} ${JSON.stringify(r.body)}`); process.exit(1); }
        inserted++;
      }
    }
  }
  if (APPLY) console.log(`\n  inserted ${inserted} customer_product_prices rows`);

  console.log(APPLY ? "DONE" : "\nDONE — dry-run only.");
} finally {
  await sql.end();
}
