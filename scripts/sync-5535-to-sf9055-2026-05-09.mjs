// One-shot — sync customer-specific 5535 prices for Carress (cust-2) and
// 2990 HOME (cust-f6c80b96) to match the supplier SF 9055 price sheet.
//
// Scope:
//   - 12 SOFA components: 1NA/2NA/1S/2S/3S/1A LHF&RHF/2A LHF&RHF/CNR/L LHF&RHF
//   - PRICE_2 tier (the base/cheaper-fabric tier) at 4 seat heights from
//     the supplier sheet: 24/26/28/30
//   - PRICE_2 at 32/35 + ALL PRICE_3 entries copied verbatim from current
//     5535 master so resolution still works for those tier+size combos
//
// SF 9055 component→5535 mapping (Wei Siang 2026-05-09):
//   1R  → 1A (LHF + RHF)
//   2R  → 2A (LHF + RHF)
//   1NA → 1NA, 2NA → 2NA, 1 SEATER → 1S, 2 SEATER → 2S, 3 SEATER → 3S
//   CORNER → CNR, L → L (LHF + RHF)
//
// Action: POST /api/customer-products/:cpId/prices with effectiveFrom=today.
// Reversible — adds a history row; old prices stay queryable for past asOf.
//
// Usage:
//   node scripts/sync-5535-to-sf9055-2026-05-09.mjs           # dry-run
//   node scripts/sync-5535-to-sf9055-2026-05-09.mjs --apply   # write
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const APPLY = process.argv.includes("--apply");

// SF 9055 supplier prices (sen) by 5535 component code, by seat height.
// Read directly off the price sheet — 4 sizes (24/26/28/30) covered.
const SF9055_PRICE_SEN = {
  "5535-1NA":     { 24:  50000, 26:  55000, 28:  55000, 30:  55000 },
  "5535-2NA":     { 24: 100000, 26: 110000, 28: 110000, 30: 110000 },
  "5535-1S":      { 24:  80500, 26:  85100, 28:  85100, 30:  87400 },
  "5535-2S":      { 24: 115500, 26: 122100, 28: 122100, 30: 125400 },
  "5535-3S":      { 24: 154000, 26: 162800, 28: 162800, 30: 167200 },
  "5535-1A(LHF)": { 24:  55000, 26:  66000, 28:  66000, 30:  66000 },
  "5535-1A(RHF)": { 24:  55000, 26:  66000, 28:  66000, 30:  66000 },
  "5535-2A(LHF)": { 24: 105000, 26: 110000, 28: 110000, 30: 121000 },
  "5535-2A(RHF)": { 24: 105000, 26: 110000, 28: 110000, 30: 121000 },
  "5535-CNR":     { 24:  90000, 26:  90000, 28:  90000, 30:  90000 },
  "5535-L(LHF)":  { 24: 105000, 26: 110000, 28: 110000, 30: 115000 },
  "5535-L(RHF)":  { 24: 105000, 26: 110000, 28: 110000, 30: 115000 },
};
const PRODUCT_CODES = Object.keys(SF9055_PRICE_SEN);
const CUSTOMERS = [
  { id: "cust-2",          label: "Carress (300-C)" },
  { id: "cust-f6c80b96",   label: "2990 HOME (300-2)" },
];

// ---------- auth ----------
async function loginAndGetSession() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const csrfToken = j?.data?.csrfToken;
  if (!csrfToken) throw new Error(`no csrfToken in response: ${JSON.stringify(j)}`);
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  if (!cookieHeader) throw new Error("login returned no Set-Cookie");
  return { csrfToken, cookieHeader };
}
async function authedJson(session, method, path, body) {
  const headers = { "Content-Type": "application/json", Cookie: session.cookieHeader };
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = session.csrfToken;
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: res.status, ok: res.ok, body: j };
}

// ---------- DB read for master prices ----------
const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  const session = await loginAndGetSession();
  console.log(APPLY ? "MODE: APPLY (writes)" : "MODE: DRY-RUN (read-only)");
  console.log("logged in OK\n");

  // 1. Master seat_height_prices for the 12 components
  const masterRows = await sql`
    SELECT id, code, seat_height_prices
      FROM products
     WHERE code = ANY(${PRODUCT_CODES})
  `;
  const masterByCode = new Map();
  for (const r of masterRows) {
    let tiers = [];
    try {
      tiers = typeof r.seat_height_prices === "string"
        ? JSON.parse(r.seat_height_prices)
        : (Array.isArray(r.seat_height_prices) ? r.seat_height_prices : []);
    } catch { tiers = []; }
    masterByCode.set(r.code, { id: r.id, tiers });
  }
  for (const code of PRODUCT_CODES) {
    if (!masterByCode.has(code)) {
      console.error(`master missing: ${code} — abort`);
      process.exit(1);
    }
  }

  // 2. Build override seat_height_prices for each component
  function buildOverride(code) {
    const sf = SF9055_PRICE_SEN[code];
    const masterTiers = masterByCode.get(code).tiers;

    // Keep existing master tier rows VERBATIM, except: PRICE_2 entries at
    // 24/26/28/30 are replaced by SF 9055 values. PRICE_2 @ 32/35 and ALL
    // PRICE_3 rows pass through unchanged. New PRICE_2 @ 26 is added when
    // the master doesn't have it yet (likely missing for most products).
    const out = [];
    const keep = (t) => {
      if (t.tier === "PRICE_2" && t.height in sf) return false; // override
      return true;
    };
    for (const t of masterTiers) if (keep(t)) out.push({ ...t });
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

  // 3. Look up customer_products per customer for these 12 product ids
  for (const cust of CUSTOMERS) {
    console.log(`\n========================================`);
    console.log(`Customer: ${cust.label}  (${cust.id})`);
    console.log(`========================================`);

    const cpRows = await sql`
      SELECT cp.id AS cp_id, cp.product_id, p.code
        FROM customer_products cp
        JOIN products p ON p.id = cp.product_id
       WHERE cp.customer_id = ${cust.id}
         AND p.code = ANY(${PRODUCT_CODES})
       ORDER BY p.code
    `;
    const cpByCode = new Map(cpRows.map((r) => [r.code, r.cp_id]));
    for (const code of PRODUCT_CODES) {
      if (!cpByCode.has(code)) {
        console.error(`  ✗ missing customer_products row for ${code} — bulk-assign first`);
        process.exit(1);
      }
    }

    for (const code of PRODUCT_CODES) {
      const cpId = cpByCode.get(code);
      const override = buildOverride(code);
      const sf = SF9055_PRICE_SEN[code];
      const masterTiers = masterByCode.get(code).tiers;
      const masterP2 = Object.fromEntries(
        masterTiers.filter((t) => t.tier === "PRICE_2").map((t) => [t.height, t.priceSen])
      );

      // Compact diff line: PRICE_2 at 24/26/28/30 (the tier we're touching)
      const diff = [24, 26, 28, 30].map((h) => {
        const oldP = masterP2[String(h)];
        const newP = sf[h];
        const oldStr = oldP === undefined ? "—" : (oldP / 100).toFixed(0);
        const newStr = (newP / 100).toFixed(0);
        const tag = oldP === newP ? "=" : (oldP === undefined ? "+" : (newP < oldP ? "↓" : "↑"));
        return `${h}":${oldStr}${tag}${newStr}`;
      }).join("  ");
      console.log(`  ${code.padEnd(15)} P2  ${diff}`);

      if (APPLY) {
        const today = new Date().toISOString().slice(0, 10);
        const r = await authedJson(session, "POST", `/api/customer-products/${cpId}/prices`, {
          effectiveFrom: today,
          basePriceSen: null, // keep existing base; we only override seat tiers
          price1Sen: null,
          seatHeightPrices: override,
          notes: "Sync to SF 9055 supplier sheet (2026-05-09)",
          createdBy: "Wei Siang via script",
        });
        if (!r.ok) {
          console.error(`    ✗ POST failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
          process.exit(1);
        }
      }
    }
  }

  console.log(APPLY
    ? `\nDONE — ${PRODUCT_CODES.length * CUSTOMERS.length} customer_product_prices history rows added.`
    : "\nDONE — dry-run only. Re-run with --apply to write.");
} finally {
  await sql.end();
}
