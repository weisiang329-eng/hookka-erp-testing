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

async function main() {
  const live = process.argv[2] === "--live";
  const auth = await login();
  const r = await fetch(`${BASE}/api/import/backfill-supplier-sku-1to1`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ dryRun: !live }),
  });
  const j = await r.json();
  console.log(`status: ${r.status} | mode: ${live ? "LIVE" : "DRY-RUN"}`);
  console.log(`mismatchCount: ${j.mismatchCount ?? j.updated}`);
  console.log("\nTop mismatched supplierSku values:");
  for (const t of j.topMismatchedSkus || []) {
    console.log(`  "${t.sku}": ${t.count} rows`);
  }
  if (j.sampleChanges) {
    console.log("\nSample changes (first 20):");
    for (const c of j.sampleChanges) {
      console.log(`  ${c.materialCode}: "${c.supplierSku_before}" → "${c.supplierSku_after}"`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
