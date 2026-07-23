// Re-date today's 5535 customer prices for Carress + 2990 from
// 2026-05-09 → 2026-05-10. Same data, just shifted to align with 5531/5539.
//
// Action: read each row's seat_height_prices, DELETE, re-INSERT with new
// effectiveFrom.
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");
const NEW_EFFECTIVE = "2026-05-10";
const CUSTOMERS = ["cust-2", "cust-f6c80b96"];

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

  // Get today's 5535 sync rows (the canonical "SF 9055 sync — PRICE_2 only" notes)
  const rows = await sql`
    SELECT cpp.id AS price_row_id, cpp.customer_product_id, cpp.seat_height_prices,
           cpp.notes, cp.customer_id, p.code
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = '2026-05-09'
       AND cpp.notes LIKE 'SF 9055 sync — PRICE_2 only%'
       AND cp.customer_id = ANY(${CUSTOMERS})
       AND p.code LIKE '5535-%'
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`Found ${rows.length} 5535 row(s) currently effective 2026-05-09`);

  if (APPLY) {
    // Delete then re-insert with new effectiveFrom
    for (const r of rows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) { console.error(`  ✗ DELETE ${r.price_row_id}: ${d.status}`); process.exit(1); }
    }
    console.log(`  deleted ${rows.length}`);

    let inserted = 0;
    for (const r of rows) {
      const arr = typeof r.seat_height_prices === "string"
        ? JSON.parse(r.seat_height_prices)
        : r.seat_height_prices;
      const r2 = await authedJson(session, "POST", `/api/customer-products/${r.customer_product_id}/prices`, {
        effectiveFrom: NEW_EFFECTIVE,
        basePriceSen: null,
        price1Sen: null,
        seatHeightPrices: arr,
        notes: `Re-dated from 2026-05-09 to ${NEW_EFFECTIVE} (Wei Siang: "全部放明天")`,
        createdBy: "Wei Siang via push-5535-to-tomorrow",
      });
      if (!r2.ok) { console.error(`  ✗ POST ${r.customer_id}/${r.code}: ${r2.status}`); process.exit(1); }
      inserted++;
    }
    console.log(`  inserted ${inserted}`);
  }

  console.log(APPLY ? "DONE" : "DONE — dry-run only.");
} finally {
  await sql.end();
}
