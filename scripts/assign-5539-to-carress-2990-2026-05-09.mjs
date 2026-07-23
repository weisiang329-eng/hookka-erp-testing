// One-shot — assign all 8 active 5539 SOFA components to:
//   - Carress (cust-2)
//   - 2990 HOME SDN BHD (cust-f6c80b96)
// via the official POST /api/customer-products/bulk-assign endpoint
// (same path the frontend "Bulk Assign" action uses — no direct DB writes).
//
// Auth: POST /api/auth/login with the same credential pattern as
// scripts/import-historical-purchases.py.
//
// Usage: node scripts/assign-5539-to-carress-2990-2026-05-09.mjs

const API_BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

async function loginAndGetSession() {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login HTTP ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  const csrfToken = j?.data?.csrfToken;
  if (!csrfToken) throw new Error(`no csrfToken in response: ${JSON.stringify(j)}`);
  // Cookies come back as one or more Set-Cookie headers; keep them all and
  // replay verbatim on subsequent requests.
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookieHeader) throw new Error("login returned no Set-Cookie header");
  return { csrfToken, cookieHeader };
}

async function authedJson(session, method, path, body) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: session.cookieHeader,
  };
  if (method !== "GET" && method !== "HEAD") {
    headers["x-csrf-token"] = session.csrfToken;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: res.status, ok: res.ok, body: j };
}

const session = await loginAndGetSession();
console.log("logged in OK");

// Look up the 8 5539 product IDs by listing products + filtering. Use the
// existing GET /api/products endpoint (the same one the frontend reads).
const prodResp = await authedJson(session, "GET", "/api/products?status=ACTIVE");
if (!prodResp.ok) {
  throw new Error(`/api/products GET failed: HTTP ${prodResp.status}: ${JSON.stringify(prodResp.body)}`);
}
const allProducts = prodResp.body?.data ?? [];
const fiveThirtyNine = allProducts.filter(
  (p) => typeof p?.code === "string" && p.code.startsWith("5539-"),
);
console.log(`found ${fiveThirtyNine.length} 5539 product(s):`);
for (const p of fiveThirtyNine) {
  console.log(`  ${p.code.padEnd(20)} id=${p.id}  ${p.name ?? ""}`);
}
if (fiveThirtyNine.length === 0) {
  throw new Error("no 5539 products found via API — check /api/products response shape");
}
const productIds = fiveThirtyNine.map((p) => p.id);

const customers = [
  { id: "cust-2", label: "Carress (300-C)" },
  { id: "cust-f6c80b96", label: "2990 HOME SDN BHD (300-2)" },
];

for (const c of customers) {
  console.log(`\n→ POST /bulk-assign customer=${c.label}, ${productIds.length} product(s)`);
  const r = await authedJson(session, "POST", "/api/customer-products/bulk-assign", {
    customerId: c.id,
    productIds,
  });
  console.log(`  HTTP ${r.status}  ${JSON.stringify(r.body)}`);
  if (!r.ok) {
    console.error(`  ✗ failed for ${c.label} — ABORTING`);
    process.exit(1);
  }
}

console.log("\nDone.");
