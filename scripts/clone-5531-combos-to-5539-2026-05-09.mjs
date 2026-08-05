// Clone 5531 customer-scoped combos to 5539 for Carress + 2990 — Wei
// Siang 2026-05-09 "一模一样的 package".
//
// Combos to clone (3 of 4):
//   1. [[1A(LHF),1A(RHF)],[2A(LHF),2A(RHF)]]
//   2. [[1NA],[2A(LHF),2A(RHF)],[L(LHF),L(RHF)]]
//   4. [[2A(LHF),2A(RHF)],[L(LHF),L(RHF)]]
// Combo 3 (1S+2S+3S) skipped — 5539 has no 1S/2S/3S in master.
//
// Prices: latest effective (effective_from <= 2026-05-10) 5531 customer
// row per shape. Carress + 2990 should have the same price so either
// customer's row is fine; pick Carress as canonical source.
//
// New 5539 combos: customerId scoped, fabric_tier=PRICE_2, effective_from=
// 2026-05-10, prices verbatim copy.
//
// Usage:
//   node scripts/clone-5531-combos-to-5539-2026-05-09.mjs           # dry-run
//   node scripts/clone-5531-combos-to-5539-2026-05-09.mjs --apply
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

// Shapes to clone (string-stringify match against component_sizes JSON)
const SHAPES_TO_CLONE = [
  JSON.stringify([["1A(LHF)","1A(RHF)"],["2A(LHF)","2A(RHF)"]]),
  JSON.stringify([["1NA"],["2A(LHF)","2A(RHF)"],["L(LHF)","L(RHF)"]]),
  JSON.stringify([["2A(LHF)","2A(RHF)"],["L(LHF)","L(RHF)"]]),
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
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
  const session = await loginAndGetSession();

  // Pull latest effective 5531 row per shape from Carress (cust-2 = canonical
  // source; 2990 should match).
  const sourceRows = await sql`
    SELECT id, component_sizes, fabric_tier, prices_by_height, effective_from
      FROM sofa_combo_rules
     WHERE customer_id = 'cust-2'
       AND base_model = '5531'
       AND fabric_tier = 'PRICE_2'
       AND effective_from <= ${EFFECTIVE_FROM}
     ORDER BY component_sizes, effective_from DESC, created_at DESC
  `;
  // Group by shape, take latest per shape
  const latestByShape = new Map();
  for (const r of sourceRows) {
    const shape = typeof r.component_sizes === "string" ? r.component_sizes : JSON.stringify(r.component_sizes);
    if (SHAPES_TO_CLONE.includes(shape) && !latestByShape.has(shape)) {
      latestByShape.set(shape, r);
    }
  }
  for (const shape of SHAPES_TO_CLONE) {
    if (!latestByShape.has(shape)) {
      console.error(`✗ no 5531 source row for shape ${shape}`);
      process.exit(1);
    }
  }
  console.log(`Source: 3 shapes × ${CUSTOMERS.length} customers = ${SHAPES_TO_CLONE.length * CUSTOMERS.length} new 5539 combos`);

  for (const shape of SHAPES_TO_CLONE) {
    const src = latestByShape.get(shape);
    const prices = typeof src.prices_by_height === "string" ? JSON.parse(src.prices_by_height) : src.prices_by_height;
    const compShort = shape.replace(/[\[\]"]/g, "").replace(/,/g, ", ");
    const priceStr = Object.entries(prices).map(([h, v]) => `${h}=${(v/100).toFixed(2)}`).join("  ");
    console.log(`\n  shape: ${compShort}`);
    console.log(`  prices (from 5531 eff ${src.effective_from}): ${priceStr}`);
  }

  if (APPLY) {
    let inserted = 0;
    for (const shape of SHAPES_TO_CLONE) {
      const src = latestByShape.get(shape);
      const componentSizes = typeof src.component_sizes === "string" ? JSON.parse(src.component_sizes) : src.component_sizes;
      const prices = typeof src.prices_by_height === "string" ? JSON.parse(src.prices_by_height) : src.prices_by_height;
      for (const cust of CUSTOMERS) {
        const r = await authedJson(session, "POST", "/api/sofa-combos", {
          baseModel: "5539",
          componentSizes,
          fabricTier: "PRICE_2",
          pricesByHeight: prices,
          customerId: cust.id,
          effectiveFrom: EFFECTIVE_FROM,
          notes: `Cloned from 5531 ${src.id} (Wei Siang 2026-05-09: 一模一样的 package)`,
          createdBy: "Wei Siang via clone-5531-to-5539",
        });
        if (!r.ok) {
          console.error(`✗ POST ${cust.id} shape=${shape}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
          process.exit(1);
        }
        inserted++;
      }
    }
    console.log(`\n  inserted ${inserted}`);
  }

  console.log(APPLY ? "DONE" : "DONE — dry-run only.");
} finally {
  await sql.end();
}
