// Create customer-scoped 5535 combos for Carress + 2990 that override
// the master combos which currently include a 35" entry — Wei Siang
// 2026-05-09: "Carress 和 2990 的 35 寸 combo 也 remove 掉".
//
// Strategy: for each of the 4 master 5535 combos that has a 35" entry,
// POST 2 customer-scoped duplicates (one per customer) with prices_by_height
// stripped of the 35" key. Customer-scoped wins over master, so the 35"
// price disappears from the customer's quotation.
//
// Usage:
//   node scripts/strip-35-from-carress-2990-combos-2026-05-09.mjs           # dry-run
//   node scripts/strip-35-from-carress-2990-combos-2026-05-09.mjs --apply
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

  // 1. Find master 5535 combos with a 35" entry.
  const masterRows = await sql`
    SELECT id, base_model, component_sizes, fabric_tier, prices_by_height
      FROM sofa_combo_rules
     WHERE customer_id IS NULL
       AND base_model = '5535'
       AND prices_by_height::text LIKE '%"35"%'
     ORDER BY id
  `;
  console.log(`Found ${masterRows.length} master 5535 combo(s) with a 35" entry`);

  // 2. For each master, build a customer-scoped duplicate with 35 stripped.
  const targets = [];
  for (const m of masterRows) {
    const prices = typeof m.prices_by_height === "string"
      ? JSON.parse(m.prices_by_height)
      : m.prices_by_height;
    const stripped = { ...prices };
    delete stripped["35"];
    if (Object.keys(stripped).length === 0) continue; // refuse to write empty
    const componentSizes = typeof m.component_sizes === "string"
      ? JSON.parse(m.component_sizes)
      : m.component_sizes;
    for (const cust of CUSTOMERS) {
      targets.push({ master: m, cust, componentSizes, stripped });
    }
  }
  console.log(`\nWill create ${targets.length} customer-scoped row(s) (${masterRows.length} master × ${CUSTOMERS.length} customers)`);

  for (const t of targets) {
    const compStr = JSON.stringify(t.componentSizes);
    const priceStr = Object.entries(t.stripped).map(([h, v]) => `${h}=${(v/100).toFixed(2)}`).join(", ");
    console.log(`  ${t.cust.label.padEnd(12)} ${t.master.base_model} comp=${compStr} prices={${priceStr}}`);
  }

  if (APPLY) {
    let inserted = 0;
    for (const t of targets) {
      const r = await authedJson(session, "POST", "/api/sofa-combos", {
        baseModel: t.master.base_model,
        componentSizes: t.componentSizes,
        fabricTier: t.master.fabric_tier,
        pricesByHeight: t.stripped,
        customerId: t.cust.id,
        effectiveFrom: EFFECTIVE_FROM,
        notes: `Override master ${t.master.id} — drop 35" for ${t.cust.label} (Wei Siang 2026-05-09)`,
        createdBy: "Wei Siang via strip-35-combos",
      });
      if (!r.ok) {
        console.error(`  ✗ POST ${t.cust.id}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
        process.exit(1);
      }
      inserted++;
    }
    console.log(`\n  inserted ${inserted}`);
  }

  console.log(APPLY ? "DONE" : "DONE — dry-run only.");
} finally {
  await sql.end();
}
