// Revert the 5539 portion of today's sync-5531-5539-discount-2026-05-10.mjs
// — 5539 master products are incomplete (8 components only, no 1S/2S/3S/
// 2NA/STOOL), so Wei Siang doesn't want customer-specific 5539 prices yet.
//
// Keep 5531 rows (26 entries × 2 customers). Delete only the 5539 ones
// (8 × 2 = 16 entries), via the official DELETE endpoint.
//
// Usage:
//   node scripts/revert-5539-sync-2026-05-09.mjs           # dry-run
//   node scripts/revert-5539-sync-2026-05-09.mjs --apply
import postgres from "postgres";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");
const EFFECTIVE = "2026-05-10";

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
async function authedJson(session, method, path) {
  const headers = { Cookie: session.cookieHeader };
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = session.csrfToken;
  const res = await fetch(`${API_BASE}${path}`, { method, headers });
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

  const rows = await sql`
    SELECT cpp.id AS price_row_id, cp.customer_id, p.code
      FROM customer_product_prices cpp
      JOIN customer_products cp ON cp.id = cpp.customer_product_id
      JOIN products p ON p.id = cp.product_id
     WHERE cpp.effective_from = ${EFFECTIVE}
       AND cpp.notes LIKE 'Sync 5531/5539 from 5535%'
       AND cp.customer_id = ANY(${CUSTOMERS})
       AND p.code LIKE '5539-%'
     ORDER BY cp.customer_id, p.code
  `;
  console.log(`\nFound ${rows.length} 5539 row(s) to delete (effectiveFrom=${EFFECTIVE}):`);
  for (const r of rows) {
    console.log(`  ${r.price_row_id}  cust=${r.customer_id}  ${r.code}`);
  }

  if (APPLY) {
    let deleted = 0;
    for (const r of rows) {
      const d = await authedJson(session, "DELETE", `/api/customer-products/price-row/${r.price_row_id}`);
      if (!d.ok) { console.error(`  ✗ DELETE ${r.price_row_id}: ${d.status}`); process.exit(1); }
      deleted++;
    }
    console.log(`\n  deleted ${deleted}`);
  }

  console.log(APPLY ? "DONE" : "DONE — dry-run only.");
} finally {
  await sql.end();
}
