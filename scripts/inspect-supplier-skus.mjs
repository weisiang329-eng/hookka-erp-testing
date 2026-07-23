#!/usr/bin/env node
const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = r.headers.get("set-cookie") || "";
  const cookies = setCookie.split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
  const j = await r.json();
  return { cookies, csrf: j?.data?.csrfToken || "" };
}

async function get(path, auth) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf } });
  return await r.json();
}

async function main() {
  const auth = await login();

  // Try the supplier-materials endpoint
  const r = await get("/api/supplier-materials?limit=1000", auth);
  const list = r?.data?.rows || r?.data || r || [];
  console.log(`Total bindings: ${list.length}`);

  // Stats: how many have supplierSku == "PC151-01"
  const pc15101 = list.filter((s) => s.supplierSku === "PC151-01");
  console.log(`Rows with supplierSku="PC151-01": ${pc15101.length}`);

  // Mismatch: rows where supplierSku != materialCode
  const mismatch = list.filter((s) =>
    s.supplierSku && s.materialCode && s.supplierSku !== s.materialCode
  );
  console.log(`Rows where supplierSku != materialCode: ${mismatch.length}`);

  // Show sample
  console.log("\n=== Sample rows (first 20) ===");
  for (const s of list.slice(0, 20)) {
    const flag = s.supplierSku && s.materialCode && s.supplierSku !== s.materialCode ? "❌" : "✓";
    console.log(`  ${flag} internal=${s.materialCode} | name=${s.materialName} | supplierSku=${s.supplierSku} | desc=${s.supplierDescription || "—"}`);
  }

  // Distribution of supplierSku values
  const dist = new Map();
  for (const s of list) {
    const k = s.supplierSku || "(blank)";
    dist.set(k, (dist.get(k) || 0) + 1);
  }
  console.log(`\n=== Top 10 supplierSku values ===`);
  for (const [v, n] of [...dist.entries()].sort((a,b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${v}: ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
